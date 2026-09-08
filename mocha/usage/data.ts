import { t } from "../shared/i18n/index.ts";
import type { Bucket, Ledger, Totals, UsageRow } from "./types.ts";
import { fields } from "./types.ts";

export function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function emptyTotals(): Totals {
	return {
		calls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function validTotals(value: unknown): value is Totals {
	return (
		isObject(value) &&
		fields.every(
			(key) =>
				typeof value[key] === "number" &&
				Number.isFinite(value[key]) &&
				value[key] >= 0,
		)
	);
}

export function validBucket(value: unknown): value is Bucket {
	return (
		isObject(value) &&
		validTotals(value) &&
		typeof value.date === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
		["kind", "provider", "model"].every((key) => typeof value[key] === "string")
	);
}

export function bucketKey(
	bucket: Pick<Bucket, "date" | "kind" | "provider" | "model">,
): string {
	return JSON.stringify([
		bucket.date,
		bucket.kind,
		bucket.provider,
		bucket.model,
	]);
}

export function combine(...groups: Bucket[][]): Bucket[] {
	const result = new Map<string, Bucket>();
	for (const group of groups) {
		for (const bucket of group) {
			const key = bucketKey(bucket);
			const target = result.get(key);
			if (!target) result.set(key, { ...bucket });
			else for (const field of fields) target[field] += bucket[field];
		}
	}
	return [...result.values()].sort((a, b) =>
		bucketKey(a).localeCompare(bucketKey(b)),
	);
}

export function difference(
	current: Bucket[],
	previous: Bucket[],
): Bucket[] | undefined {
	const result = new Map(current.map((row) => [bucketKey(row), { ...row }]));
	for (const old of previous) {
		const row = result.get(bucketKey(old));
		if (!row) return undefined;
		for (const field of fields) {
			const delta = row[field] - old[field];
			const tolerance =
				field === "cost"
					? Number.EPSILON * Math.max(1, row[field], old[field]) * 16
					: 0;
			if (delta < -tolerance) return undefined;
			row[field] = Math.max(0, delta);
		}
	}
	return [...result.values()].filter((row) =>
		fields.some((field) => row[field] !== 0),
	);
}

export function dateFormatter(timeZone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
}

export function dateKey(
	timestamp: number,
	formatter: Intl.DateTimeFormat,
): string {
	const parts = formatter.formatToParts(timestamp);
	const part = (type: string) =>
		parts.find((item) => item.type === type)?.value;
	return `${part("year")}-${part("month")}-${part("day")}`;
}

export function rowBucket(
	row: UsageRow,
	formatter: Intl.DateTimeFormat,
): Bucket {
	const { type: _type, timestamp, ...totals } = row;
	return { ...totals, date: dateKey(timestamp, formatter) };
}

export function newLedger(
	timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Ledger {
	dateFormatter(timeZone);
	return { version: 1, timeZone, lastLogId: 0, lastSweepAt: null, daily: [] };
}

export function parseDays(input: string): number {
	const value = input.trim().toLowerCase();
	if (!value) return 7;
	if (value === "all" || value === "0") return 0;
	if (!/^\d+$/.test(value)) throw new Error(t("usage.invalidDays"));
	const days = Number(value);
	if (!Number.isSafeInteger(days) || days > 365000)
		throw new Error(t("usage.daysOutOfRange"));
	return days;
}

export function report(
	ledger: Ledger,
	days: number,
	now = Date.now(),
): Bucket[] {
	const today = dateKey(now, dateFormatter(ledger.timeZone));
	const cutoff =
		days === 0
			? ""
			: new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86400000)
					.toISOString()
					.slice(0, 10);
	return ledger.daily.filter(
		(row) => !days || (row.date >= cutoff && row.date <= today),
	);
}
