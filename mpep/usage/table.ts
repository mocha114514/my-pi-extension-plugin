import type { Theme } from "@earendil-works/pi-coding-agent";
import { t } from "../shared/i18n/index.ts";
import {
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { emptyTotals, report } from "./data.ts";
import type { ModelTarget } from "./pricing.ts";
import { type Bucket, fields, type Progress, type Totals } from "./types.ts";

export const columns = [
	{ key: "modelKey", get label() { return t("column.model"); } },
	{ key: "calls", get label() { return t("column.calls"); } },
	{ key: "input", get label() { return t("column.input"); } },
	{ key: "output", get label() { return t("column.output"); } },
	{ key: "cacheRead", get label() { return t("column.cacheRead"); } },
	{ key: "cacheWrite", get label() { return t("column.cacheWrite"); } },
	{ key: "cacheRate", get label() { return t("column.cacheRate"); } },
	{ key: "tokens", get label() { return t("column.tokens"); } },
	{ key: "cost", get label() { return t("column.cost"); } },
] as const;

export type SortColumn = (typeof columns)[number]["key"];
export interface SortOrder {
	column: SortColumn;
	descending: boolean;
}
export interface ReportSource {
	state: Progress;
	complete: boolean;
	error?: string;
}
export interface ModelRow extends Totals {
	modelKey: string;
	target?: ModelTarget;
	cacheRate: number;
	tokens: number;
}
export interface HeaderCell {
	column: SortColumn;
	x: number;
	y: number;
	width: number;
}
export interface ReportView {
	headers: string[];
	body: string[];
	total: string[];
	cells: HeaderCell[];
	models: ModelCell[];
	status: string;
	footers: string[];
}

export interface ModelCell extends ModelTarget {
	x: number;
	y: number;
	width: number;
}

export function formatNumber(value: number): string {
	if (value < 1000) return String(value);
	for (const [divisor, suffix] of [
		[1e9, "b"],
		[1e6, "m"],
		[1e3, "k"],
	] as const) {
		if (value >= divisor)
			return `${(value / divisor).toFixed(value / divisor >= 100 ? 0 : 1).replace(/\.0$/, "")}${suffix}`;
	}
	return String(value);
}

function withRates(
	row: Totals & { modelKey: string; target?: ModelTarget },
): ModelRow {
	const prompt = row.input + row.cacheRead + row.cacheWrite;
	return {
		...row,
		cacheRate: prompt ? (row.cacheRead / prompt) * 100 : 0,
		tokens: prompt + row.output,
	};
}

export function modelRows(
	buckets: Bucket[],
	modelOrder: readonly string[],
	sort?: SortOrder,
): ModelRow[] {
	const grouped = new Map<
		string,
		Totals & { modelKey: string; target?: ModelTarget }
	>();
	for (const bucket of buckets) {
		const modelKey =
			bucket.kind === "assistant"
				? `${bucket.provider}/${bucket.model}`
				: "Tools/summaries";
		const row = grouped.get(modelKey) ?? {
			...emptyTotals(),
			modelKey,
			...(bucket.kind === "assistant"
				? { target: { provider: bucket.provider, model: bucket.model } }
				: {}),
		};
		for (const field of fields) row[field] += bucket[field];
		grouped.set(modelKey, row);
	}
	const ranks = new Map<string, number>();
	for (const key of modelOrder) if (!ranks.has(key)) ranks.set(key, ranks.size);
	const alphabet = new Intl.Collator("en", {
		sensitivity: "base",
		numeric: true,
	});
	const defaultOrder = (a: ModelRow, b: ModelRow) => {
		const rank = (key: string) =>
			ranks.get(key) ??
			(key === "Tools/summaries" ? ranks.size + 1 : ranks.size);
		return (
			rank(a.modelKey) - rank(b.modelKey) ||
			alphabet.compare(a.modelKey, b.modelKey)
		);
	};
	return [...grouped.values()].map(withRates).sort((a, b) => {
		if (!sort) return defaultOrder(a, b);
		const difference =
			sort.column === "modelKey"
				? alphabet.compare(a.modelKey, b.modelKey)
				: a[sort.column] - b[sort.column];
		return difference * (sort.descending ? -1 : 1) || defaultOrder(a, b);
	});
}

function values(row: ModelRow): string[] {
	return [
		stripTerminalSequences(row.modelKey === "Tools/summaries" ? t("column.tools") : row.modelKey).replace(/[\r\n\t]/g, " "),
		formatNumber(row.calls),
		formatNumber(row.input),
		formatNumber(row.output),
		formatNumber(row.cacheRead),
		formatNumber(row.cacheWrite),
		`${row.cacheRate.toFixed(1)}%`,
		formatNumber(row.tokens),
		`$${row.cost.toFixed(row.cost > 0 && row.cost < 0.01 ? 3 : 2)}`,
	];
}

export function buildReport(
	source: ReportSource,
	days: number,
	theme: Theme,
	width: number,
	modelOrder: readonly string[] = [],
	sort?: SortOrder,
	hovered?: SortColumn,
	hoveredModel?: string,
): ReportView {
	const { state } = source;
	const rows = modelRows(
		state.ledger ? report(state.ledger, days) : [],
		modelOrder,
		sort,
	);
	const sum = { ...emptyTotals(), modelKey: t("column.total") };
	for (const row of rows) for (const field of fields) sum[field] += row[field];
	const data = [...rows, withRates(sum)].map(values);
	const sizes = columns.map((column, index) =>
		index === 0
			? 16
			: Math.max(
					visibleWidth(column.label) + 1,
					...data.map((row) => visibleWidth(row[index])),
				),
	);
	const numericWidth = sizes
		.slice(1)
		.reduce((sum, size) => sum + size, columns.length - 1);
	const wide = width >= numericWidth + sizes[0];
	sizes[0] = Math.max(1, width - numericWidth);
	const header = (index: number) => {
		const column = columns[index];
		const arrow =
			sort?.column === column.key
				? sort.descending
					? "\u2193"
					: "\u2191"
				: " ";
		const text = `${column.label}${arrow}`;
		return theme.fg(
			hovered === column.key || sort?.column === column.key ? "accent" : "text",
			theme.bold(text),
		);
	};
	const headers: string[] = [];
	const cells: HeaderCell[] = [];
	if (wide) {
		let x = 0;
		headers.push(
			columns
				.map((column, i) => {
					cells.push({ column: column.key, x, y: 0, width: sizes[i] });
					x += sizes[i] + 1;
					const padding = " ".repeat(sizes[i] - visibleWidth(column.label) - 1);
					return i ? padding + header(i) : header(i) + padding;
				})
				.join(" "),
		);
	} else {
		let line = "";
		let x = 0;
		for (let i = 0; i < columns.length; i++) {
			const size = visibleWidth(columns[i].label) + 1;
			if (x && x + 2 + size > width) {
				headers.push(line);
				line = "";
				x = 0;
			}
			if (x) {
				line += "  ";
				x += 2;
			}
			cells.push({ column: columns[i].key, x, y: headers.length, width: size });
			line += header(i);
			x += size;
		}
		if (line) headers.push(line);
	}
	const renderRow = (
		row: string[],
		total: boolean,
		highlighted = false,
	): string[] => {
		if (wide) {
			const text = row
				.map((cell, i) => {
					const display = truncateToWidth(cell, sizes[i], "\u2026");
					const pad = " ".repeat(sizes[i] - visibleWidth(display));
					return i
						? pad + display
						: (highlighted ? theme.fg("accent", display) : display) + pad;
				})
				.join(" ");
			return [total ? theme.bold(text) : text];
		}
		const name = highlighted
			? theme.fg("accent", theme.bold(row[0]))
			: theme.bold(row[0]);
		return new Text(
			`${name}\n${t("column.calls")} ${row[1]} | ${t("column.input")} ${row[2]} | ${t("column.output")} ${row[3]}\n${t("column.cacheRead")} ${row[4]} | ${t("column.cacheWrite")} ${row[5]}\n${t("column.cacheRate")} ${row[6]} | ${t("column.tokens")} ${row[7]} | ${row[8]}`,
			0,
			0,
		).render(width);
	};
	const phases = {
		recover: t("usage.phase.recover"),
		scan: t("usage.phase.aggregate"),
		clean: t("usage.phase.cleanup"),
		sweep: t("usage.phase.audit"),
		done: t("usage.phase.done"),
	};
	const status = source.error
		? t("usage.statusFailed", { error: source.error })
		: source.complete
			? t("usage.phase.done")
			: phases[state.phase];
	const body: string[] = [];
	const models: ModelCell[] = [];
	for (const [index, row] of rows.entries()) {
		const target = row.target;
		if (target) {
			const names = wide
				? [truncateToWidth(data[index][0], sizes[0], "\u2026")]
				: new Text(theme.bold(data[index][0]), 0, 0).render(width);
			for (const [line, name] of names.entries())
				models.push({
					...target,
					x: 0,
					y: body.length + line,
					width: visibleWidth(name.trimEnd()),
				});
		}
		body.push(
			...renderRow(
				data[index],
				false,
				!!target && hoveredModel === row.modelKey,
			),
		);
	}
	if (!rows.length)
		body.push(t(source.complete ? "usage.empty" : "usage.reading"));
	for (const warning of [
		...(source.error ? [source.error] : []),
		...state.warnings,
	]) {
		body.push(...new Text(theme.fg("warning", warning), 0, 0).render(width));
	}
	return {
		headers,
		body,
		total: rows.length ? renderRow(data[data.length - 1], true) : [],
		cells,
		models,
		status: theme.fg(source.error ? "error" : "dim", status),
		footers: [
			t("usage.scan", { scanned: state.scanned, removed: state.removed }) + (state.swept ? t("usage.fullAudit") : ""),
		],
	};
}

export function renderReport(
	source: ReportSource,
	days: number,
	theme: Theme,
	width: number,
): string[] {
	const view = buildReport(source, days, theme, width);
	return new Text(
		[
			t("usage.title", { period: days ? t("usage.recentDays", { days }) : t("usage.allHistory") }),
			view.status,
			...view.headers,
			...view.body,
			...view.total,
			...view.footers,
		].join("\n"),
		0,
		0,
	).render(Math.max(1, width));
}
