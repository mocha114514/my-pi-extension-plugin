import { t } from "../shared/i18n/index.ts";
import { readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { combine, difference } from "./data.ts";
import type { UsageLedger } from "./ledger.ts";
import { sourceExists } from "./recorder.ts";
import { atomicWrite, errorCode } from "./storage.ts";
import type { Bucket, Journal, OwnerState, SourceSnapshot } from "./types.ts";

export async function cleanup(store: UsageLedger): Promise<void> {
	const identities = new Map<string, OwnerState>();
	const deletions: string[] = [];
	const changed: SourceSnapshot[] = [];
	let delta: Bucket[] = [];
	for (const [id, pending] of store.pending) {
		try {
			if (!(await sourceExists(store.root, id))) {
				store.pending.delete(id);
				continue;
			}
			const previous = await store.baseline(id);
			if (!previous) continue;
			const key = JSON.stringify(previous.owner);
			let state = identities.get(key);
			if (!state) {
				state = await store.probe(previous.owner);
				identities.set(key, state);
			}
			if (state !== "gone") {
				pending.reason = state;
				continue;
			}
			// Read the final boundary only after the original process is confirmed gone.
			const current = await store.inspect(id, previous);
			if (!current) {
				pending.reason = "incomplete";
				continue;
			}
			if (
				current.endOffset !== previous.endOffset ||
				current.invalid !== previous.invalid
			) {
				changed.push(current);
				if (!current.invalid)
					delta = combine(
						delta,
						difference(current.totals, previous.totals) ?? [],
					);
			}
			deletions.push(id);
		} catch (error) {
			pending.reason = String(error);
			store.warn(`${id}: ${String(error)}`);
		}
	}
	await store.commit(delta, changed);
	for (const id of deletions) {
		try {
			await unlink(join(store.root, "now", `${id}.jsonl`));
		} catch (error) {
			if (errorCode(error) === "ENOENT") store.pending.delete(id);
			else {
				const pending = store.pending.get(id);
				if (pending) pending.reason = String(error);
				store.warn(t("usage.cleanupFailed", { id, error: String(error) }));
			}
			continue;
		}
		store.fault?.("delete");
		store.pending.delete(id);
		store.progress.removed++;
	}
	await store.savePending();
	store.update();
}

export async function sweep(store: UsageLedger): Promise<void> {
	const errorsBefore = store.progress.warnings.length;
	const journals: Journal[] = [];
	const best = new Map<string, { logId: number; file: SourceSnapshot }>();
	const recordDir = join(store.root, "record");
	const names = await readdir(recordDir);
	for (const name of names.sort()) {
		if (name.endsWith(".log-broken") || name.endsWith(".pending")) {
			try {
				await unlink(join(recordDir, name));
			} catch (error) {
				store.warn(`${name}: ${String(error)}`);
			}
			continue;
		}
		if (!/^\d{12}\.log$/.test(name)) continue;
		const id = Number(name.slice(0, 12));
		let journal: Journal;
		try {
			journal = await store.readJournal(id);
		} catch (error) {
			store.warn(t("usage.corruptJournal", { name, error: String(error) }));
			try {
				await rename(join(recordDir, name), join(recordDir, `${name}-broken`));
				await unlink(join(recordDir, `${name}-broken`));
			} catch (failure) {
				store.warn(`${name}: ${String(failure)}`);
			}
			continue;
		}
		if (id > store.ledger.lastLogId) continue;
		journals.push(journal);
		for (const file of journal.files) {
			const old = best.get(file.id);
			if (
				!old ||
				(!old.file.invalid && file.invalid) ||
				((!old.file.invalid || file.invalid) &&
					(file.endOffset > old.file.endOffset ||
						(file.endOffset === old.file.endOffset && id > old.logId)))
			)
				best.set(file.id, { logId: id, file });
		}
	}
	for (const [id, entry] of best) {
		if (!(await sourceExists(store.root, id))) {
			store.pending.delete(id);
			continue;
		}
		store.pending.set(id, {
			id,
			logId: entry.logId,
			endOffset: entry.file.endOffset,
			...(entry.file.invalid ? { invalid: entry.file.invalid } : {}),
		});
	}
	await store.savePending();
	// Only sources represented in applied journals belong to this sweep.
	await store.scan([...best.keys()]);
	await cleanup(store);
	const references = new Set(
		[...store.pending.values()].map((value) => value.logId),
	);
	for (const journal of journals) {
		if (journal.id === store.ledger.lastLogId || references.has(journal.id))
			continue;
		let covered = true;
		for (const file of journal.files) {
			if (!(await sourceExists(store.root, file.id))) continue;
			const pending = store.pending.get(file.id);
			if (!pending || pending.logId <= journal.id) {
				covered = false;
				break;
			}
			const next = await store.baseline(file.id);
			if (
				!next ||
				(!next.invalid &&
					(file.invalid ||
						next.endOffset < file.endOffset ||
						!difference(next.totals, file.totals)))
			) {
				covered = false;
				break;
			}
		}
		if (!covered) continue;
		try {
			await unlink(store.journalPath(journal.id));
		} catch (error) {
			if (errorCode(error) !== "ENOENT")
				store.warn(t("usage.journalError", { id: journal.id, error: String(error) }));
		}
	}
	if (store.progress.warnings.length === errorsBefore) {
		store.ledger = { ...store.ledger, lastSweepAt: store.now() };
		await atomicWrite(
			join(store.root, "ledger.json"),
			`${JSON.stringify(store.ledger)}\n`,
		);
	}
	store.update();
}
