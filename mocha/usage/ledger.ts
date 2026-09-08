import { t } from "../shared/i18n/index.ts";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, sweep } from "./cleanup.ts";
import { combine, difference, newLedger } from "./data.ts";
import { probeOwner } from "./process/index.ts";
import { InvalidSource, readSnapshot, sourceExists } from "./recorder.ts";
import {
	atomicWrite,
	decodeJournal,
	decodeLedger,
	decodePending,
	encodeJournal,
	errorCode,
	optionalRead,
} from "./storage.ts";
import type {
	Bucket,
	Journal,
	Ledger,
	Pending,
	Probe,
	Progress,
	SourceSnapshot,
} from "./types.ts";
import { sourceIdPattern } from "./types.ts";

export interface LedgerOptions {
	probe?: Probe;
	now?: () => number;
	fault?: (point: "journal" | "ledger" | "pending" | "delete") => void;
}

export class UsageLedger {
	readonly root: string;
	readonly probe: Probe;
	readonly now: () => number;
	readonly fault?: LedgerOptions["fault"];
	ledger: Ledger = newLedger();
	pending = new Map<string, Pending>();
	progress: Progress = {
		phase: "recover",
		scanned: 0,
		removed: 0,
		swept: false,
		warnings: [],
	};
	private journalCache = new Map<number, Journal>();
	private notify: (state: Progress) => void = () => {};
	private nextId = 1;

	constructor(root: string, options: LedgerOptions = {}) {
		this.root = root;
		this.probe = options.probe ?? probeOwner;
		this.now = options.now ?? Date.now;
		this.fault = options.fault;
	}

	update(phase = this.progress.phase): void {
		this.progress.phase = phase;
		this.progress.ledger = this.ledger;
		this.notify({ ...this.progress, warnings: [...this.progress.warnings] });
	}

	warn(message: string): void {
		if (!this.progress.warnings.includes(message))
			this.progress.warnings.push(message);
		this.update();
	}

	journalPath(id: number): string {
		return join(this.root, "record", `${String(id).padStart(12, "0")}.log`);
	}

	async readJournal(id: number): Promise<Journal> {
		const cached = this.journalCache.get(id);
		if (cached) return cached;
		const content = await optionalRead(this.journalPath(id));
		if (content === undefined) throw new Error(`Missing journal ${id}`);
		const journal = decodeJournal(content);
		if (journal.id !== id) throw new Error(`Journal ID mismatch: ${id}`);
		this.journalCache.set(id, journal);
		return journal;
	}

	async savePending(): Promise<void> {
		this.fault?.("pending");
		const content = [...this.pending.values()]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((value) => JSON.stringify(value))
			.join("\n");
		await atomicWrite(
			join(this.root, "record", "fail_delete.jsonl"),
			content ? `${content}\n` : "",
		);
	}

	async adopt(journal: Journal): Promise<void> {
		for (const file of journal.files) {
			if (!(await sourceExists(this.root, file.id))) {
				this.pending.delete(file.id);
				continue;
			}
			const previous = this.pending.get(file.id);
			if (previous && previous.logId > journal.id) continue;
			this.pending.set(file.id, {
				id: file.id,
				logId: journal.id,
				endOffset: file.endOffset,
				...(file.invalid || previous?.invalid
					? { invalid: file.invalid ?? previous?.invalid }
					: {}),
			});
		}
	}

	async initialize(): Promise<void> {
		await mkdir(join(this.root, "now"), { recursive: true });
		await mkdir(join(this.root, "record"), { recursive: true });
		const files = await readdir(join(this.root, "record"));
		const ids = files
			.filter((name) => /^\d{12}\.log$/.test(name))
			.map((name) => Number(name.slice(0, 12)))
			.sort((a, b) => a - b);
		const content = await optionalRead(join(this.root, "ledger.json"));
		if (content === undefined) {
			if (ids.length)
				throw new Error(
					"Global ledger is missing; retained journals may not contain all historical totals",
				);
			this.ledger = newLedger();
			await atomicWrite(
				join(this.root, "ledger.json"),
				`${JSON.stringify(this.ledger)}\n`,
			);
		} else this.ledger = decodeLedger(content);
		this.nextId = Math.max(this.ledger.lastLogId, ...ids, 0) + 1;
		for (const id of ids) {
			if (id <= this.ledger.lastLogId) continue;
			let journal: Journal;
			try {
				journal = await this.readJournal(id);
			} catch (error) {
				this.warn(t("usage.journalInvalid", { id, error: String(error) }));
				continue;
			}
			await this.apply(journal);
		}
		const queue = await optionalRead(
			join(this.root, "record", "fail_delete.jsonl"),
		);
		this.pending = decodePending(queue ?? "");
		if (this.ledger.lastLogId > 0)
			await this.adopt(await this.readJournal(this.ledger.lastLogId));
		await this.savePending();
	}

	private async apply(journal: Journal): Promise<void> {
		if (journal.id <= this.ledger.lastLogId) return;
		if (journal.previous !== this.ledger.lastLogId)
			throw new Error(
				`Journal ${journal.id} does not continue the current ledger`,
			);
		const next: Ledger = {
			...this.ledger,
			daily: combine(this.ledger.daily, journal.delta),
			lastLogId: journal.id,
		};
		await atomicWrite(
			join(this.root, "ledger.json"),
			`${JSON.stringify(next)}\n`,
		);
		this.ledger = next;
		this.fault?.("ledger");
	}

	async commit(delta: Bucket[], files: SourceSnapshot[]): Promise<void> {
		if (!files.length) return;
		const journal: Journal = {
			version: 1,
			id: this.nextId++,
			previous: this.ledger.lastLogId,
			timestamp: this.now(),
			delta,
			files,
		};
		await atomicWrite(this.journalPath(journal.id), encodeJournal(journal));
		this.journalCache.set(journal.id, journal);
		this.fault?.("journal");
		await this.apply(journal);
		await this.adopt(journal);
		this.update();
		await this.savePending();
	}

	async baseline(id: string): Promise<SourceSnapshot | undefined> {
		const reference = this.pending.get(id);
		if (!reference) return undefined;
		if (reference.logId > this.ledger.lastLogId)
			throw new Error(`Unapplied baseline for ${id}`);
		const journal = await this.readJournal(reference.logId);
		const file = journal.files.find((item) => item.id === id);
		if (!file || file.endOffset !== reference.endOffset)
			throw new Error(`Invalid baseline for ${id}`);
		return reference.invalid ? { ...file, invalid: reference.invalid } : file;
	}

	async inspect(
		id: string,
		previous?: SourceSnapshot,
	): Promise<SourceSnapshot | undefined> {
		if (previous?.invalid)
			return (await sourceExists(this.root, id)) ? previous : undefined;
		try {
			if (
				previous &&
				(await stat(join(this.root, "now", `${id}.jsonl`))).size <
					previous.endOffset
			) {
				return { ...previous, invalid: "截止位置缩小" };
			}
			const current = await readSnapshot(this.root, id, this.ledger.timeZone);
			if (!current) return undefined;
			if (
				previous &&
				(current.endOffset < previous.endOffset ||
					!difference(current.totals, previous.totals))
			) {
				return { ...previous, invalid: "截止位置或累计值倒退" };
			}
			return current;
		} catch (error) {
			if (errorCode(error) === "ENOENT") return undefined;
			if (error instanceof InvalidSource && previous)
				return { ...previous, invalid: error.message };
			throw error;
		}
	}

	async scan(ids?: string[]): Promise<void> {
		const targets =
			ids ??
			(await readdir(join(this.root, "now")))
				.filter(
					(name) =>
						name.endsWith(".jsonl") && sourceIdPattern.test(name.slice(0, -6)),
				)
				.map((name) => name.slice(0, -6));
		const snapshots: SourceSnapshot[] = [];
		let delta: Bucket[] = [];
		for (const id of targets) {
			try {
				const previous = await this.baseline(id);
				const current = await this.inspect(id, previous);
				if (!current) continue;
				if (
					!previous ||
					current.endOffset !== previous.endOffset ||
					current.invalid !== previous.invalid
				) {
					snapshots.push(current);
					if (!current.invalid)
						delta = combine(
							delta,
							difference(current.totals, previous?.totals ?? []) ?? [],
						);
				}
			} catch (error) {
				this.warn(`${id}: ${String(error)}`);
			}
			this.progress.scanned++;
			this.update();
		}
		await this.commit(delta, snapshots);
	}

	async run(notify: (state: Progress) => void = () => {}): Promise<Ledger> {
		this.notify = notify;
		this.update("recover");
		await this.initialize();
		this.update("scan");
		await this.scan();
		this.update("clean");
		await cleanup(this);
		if (
			this.ledger.lastSweepAt === null ||
			Math.abs(this.now() - this.ledger.lastSweepAt) >= 7 * 86400000
		) {
			this.progress.swept = true;
			this.update("sweep");
			await sweep(this);
		}
		this.update("done");
		return this.ledger;
	}
}
