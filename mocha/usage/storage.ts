import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isObject, validBucket } from "./data.ts";
import type {
	Journal,
	Ledger,
	Owner,
	Pending,
	SourceSnapshot,
} from "./types.ts";
import { sourceIdPattern } from "./types.ts";

export function errorCode(error: unknown): string | undefined {
	return isObject(error) && typeof error.code === "string"
		? error.code
		: undefined;
}

export async function optionalRead(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

export async function atomicWrite(file: string, data: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${randomUUID()}.pending`;
	const handle = await open(temporary, "wx");
	try {
		await handle.writeFile(data, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		if ((await readFile(temporary, "utf8")) !== data)
			throw new Error("Write verification failed");
		await rename(temporary, file);
		if (process.platform !== "win32") {
			const directory = await open(dirname(file), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} finally {
		await unlink(temporary).catch((error) => {
			if (errorCode(error) !== "ENOENT") throw error;
		});
	}
}

export function validOwner(value: unknown): value is Owner {
	return (
		isObject(value) &&
		typeof value.platform === "string" &&
		typeof value.host === "string" &&
		Number.isSafeInteger(value.pid) &&
		Number(value.pid) > 0 &&
		(value.start === null || typeof value.start === "string")
	);
}

export function validSnapshot(value: unknown): value is SourceSnapshot {
	return (
		isObject(value) &&
		typeof value.id === "string" &&
		sourceIdPattern.test(value.id) &&
		validOwner(value.owner) &&
		Number.isSafeInteger(value.endOffset) &&
		Number(value.endOffset) >= 0 &&
		Array.isArray(value.totals) &&
		value.totals.every(validBucket) &&
		(value.invalid === undefined || typeof value.invalid === "string")
	);
}

export function decodeLedger(content: string): Ledger {
	const value: unknown = JSON.parse(content);
	if (
		!isObject(value) ||
		value.version !== 1 ||
		typeof value.timeZone !== "string" ||
		!Number.isSafeInteger(value.lastLogId) ||
		Number(value.lastLogId) < 0 ||
		!(
			value.lastSweepAt === null ||
			(typeof value.lastSweepAt === "number" &&
				Number.isFinite(value.lastSweepAt))
		) ||
		!Array.isArray(value.daily) ||
		!value.daily.every(validBucket)
	)
		throw new Error("Invalid global ledger");
	new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
	return value as unknown as Ledger;
}

export function encodeJournal(journal: Journal): string {
	const payload = JSON.stringify(journal);
	const checksum = createHash("sha256").update(payload).digest("hex");
	return `--start--\n${JSON.stringify({ payload, checksum })}\n--end--\n`;
}

export function decodeJournal(content: string): Journal {
	if (!content.startsWith("--start--\n") || !content.endsWith("\n--end--\n"))
		throw new Error("Incomplete journal");
	const envelope: unknown = JSON.parse(content.slice(10, -9));
	if (
		!isObject(envelope) ||
		typeof envelope.payload !== "string" ||
		createHash("sha256").update(envelope.payload).digest("hex") !==
			envelope.checksum
	)
		throw new Error("Journal checksum mismatch");
	const value: unknown = JSON.parse(envelope.payload);
	if (
		!isObject(value) ||
		value.version !== 1 ||
		!Number.isSafeInteger(value.id) ||
		Number(value.id) <= 0 ||
		!Number.isSafeInteger(value.previous) ||
		Number(value.previous) < 0 ||
		Number(value.previous) >= Number(value.id) ||
		typeof value.timestamp !== "number" ||
		!Number.isFinite(value.timestamp) ||
		!Array.isArray(value.delta) ||
		!value.delta.every(validBucket) ||
		!Array.isArray(value.files) ||
		!value.files.every(validSnapshot) ||
		new Set(value.files.map((file) => file.id)).size !== value.files.length
	)
		throw new Error("Invalid journal");
	return value as unknown as Journal;
}

export function decodePending(content: string): Map<string, Pending> {
	const entries = new Map<string, Pending>();
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const value: unknown = JSON.parse(line);
		if (
			!isObject(value) ||
			typeof value.id !== "string" ||
			!sourceIdPattern.test(value.id) ||
			!Number.isSafeInteger(value.logId) ||
			Number(value.logId) <= 0 ||
			!Number.isSafeInteger(value.endOffset) ||
			Number(value.endOffset) < 0 ||
			(value.invalid !== undefined && typeof value.invalid !== "string") ||
			(value.reason !== undefined && typeof value.reason !== "string")
		)
			throw new Error("Invalid cleanup queue");
		entries.set(value.id, value as unknown as Pending);
	}
	return entries;
}
