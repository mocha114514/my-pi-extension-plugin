import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
	bucketKey,
	dateFormatter,
	isObject,
	rowBucket,
	validTotals,
} from "./data.ts";
import { errorCode, validOwner } from "./storage.ts";
import type {
	Bucket,
	Owner,
	PriceEndpoint,
	SourceHeader,
	SourceSnapshot,
	UsageRow,
} from "./types.ts";
import { fields, sourceIdPattern } from "./types.ts";

export class Recorder {
	readonly id: string;
	readonly path: string;
	private handle: FileHandle | undefined;
	private queue = Promise.resolve();
	private ended = false;
	private header: SourceHeader;
	private offset = 0;

	constructor(
		root: string,
		owner: Owner,
		id = `${Date.now()}-${randomUUID()}`,
		notify?: PriceEndpoint,
	) {
		if (!sourceIdPattern.test(id)) throw new Error("Invalid source ID");
		this.id = id;
		this.path = join(root, "now", `${id}.jsonl`);
		this.header = {
			type: "header",
			version: 1,
			id,
			owner,
			...(notify ? { notify } : {}),
		};
	}

	async start(): Promise<void> {
		await mkdir(join(this.path, ".."), { recursive: true });
		this.handle = await open(this.path, "ax");
		const data = Buffer.from(`${JSON.stringify(this.header)}\n`);
		try {
			await this.handle.writeFile(data);
			await this.handle.sync();
		} catch (error) {
			await this.handle.close();
			this.handle = undefined;
			throw error;
		}
		this.offset = data.length;
	}

	append(row: UsageRow): Promise<void> {
		if (this.ended) return Promise.reject(new Error("Recorder is closed"));
		if (!validTotals(row) || !Number.isFinite(row.timestamp))
			return Promise.reject(new Error("Invalid usage"));
		const operation = this.queue.then(async () => {
			if (!this.handle) throw new Error("Recorder not started");
			const data = Buffer.from(`${JSON.stringify(row)}\n`);
			try {
				await this.handle.writeFile(data);
				await this.handle.sync();
				this.offset += data.length;
			} catch (error) {
				// Only the unfinished tail owned by this writer may be rolled back.
				await this.handle.truncate(this.offset);
				await this.handle.sync();
				throw error;
			}
		});
		this.queue = operation.catch(() => {});
		return operation;
	}

	async flush(): Promise<void> {
		await this.queue;
	}

	async close(): Promise<void> {
		this.ended = true;
		await this.queue;
		await this.handle?.close();
		this.handle = undefined;
	}
}

export class InvalidSource extends Error {}

export async function readSnapshot(
	root: string,
	id: string,
	timeZone: string,
): Promise<SourceSnapshot | undefined> {
	if (!sourceIdPattern.test(id)) throw new Error("Invalid source ID");
	const file = join(root, "now", `${id}.jsonl`);
	let handle: FileHandle;
	try {
		handle = await open(file, "r");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	try {
		const size = (await handle.stat()).size;
		const formatter = dateFormatter(timeZone);
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const totals = new Map<string, Bucket>();
		let header: SourceHeader | undefined;
		let pending = Buffer.alloc(0);
		let position = 0;
		let endOffset = 0;
		while (position < size) {
			const buffer = Buffer.alloc(Math.min(65536, size - position));
			const { bytesRead } = await handle.read(
				buffer,
				0,
				buffer.length,
				position,
			);
			if (!bytesRead) throw new InvalidSource("Source truncated while reading");
			position += bytesRead;
			pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
			let start = 0;
			for (
				let newline = pending.indexOf(10, start);
				newline !== -1;
				newline = pending.indexOf(10, start)
			) {
				const line = pending.subarray(start, newline);
				let value: unknown;
				try {
					value = JSON.parse(decoder.decode(line));
				} catch {
					throw new InvalidSource("Invalid complete source line");
				}
				if (!header) {
					if (
						!isObject(value) ||
						value.type !== "header" ||
						value.version !== 1 ||
						value.id !== id ||
						!validOwner(value.owner)
					) {
						throw new InvalidSource("Invalid source header");
					}
					header = value as unknown as SourceHeader;
				} else {
					if (
						!isObject(value) ||
						value.type !== "usage" ||
						!validTotals(value) ||
						typeof value.timestamp !== "number" ||
						!Number.isFinite(value.timestamp) ||
						!["kind", "provider", "model"].every(
							(key) => typeof value[key] === "string",
						)
					)
						throw new InvalidSource("Invalid usage row");
					const bucket = rowBucket(value as unknown as UsageRow, formatter);
					const key = bucketKey(bucket);
					const previous = totals.get(key);
					if (!previous) totals.set(key, bucket);
					else for (const field of fields) previous[field] += bucket[field];
				}
				endOffset += newline + 1 - start;
				start = newline + 1;
			}
			pending = Buffer.from(pending.subarray(start));
			if (pending.length > 1048576)
				throw new InvalidSource("Source line exceeds 1 MiB");
			await setImmediate();
		}
		if (!header) return undefined;
		return { id, owner: header.owner, endOffset, totals: [...totals.values()] };
	} finally {
		await handle.close();
	}
}

export async function sourceExists(root: string, id: string): Promise<boolean> {
	if (!sourceIdPattern.test(id)) throw new Error("Invalid source ID");
	try {
		await stat(join(root, "now", `${id}.jsonl`));
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}
