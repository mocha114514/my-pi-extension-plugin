import { t } from "./shared/i18n/index.ts";
import { getCacheDir } from "./shared/paths.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text, truncateToWidth, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";

const cacheRoot = () => path.join(getCacheDir(), "legacy-usage");

/**
 * Cache data structure: compact per-call record
 */
interface CachedUsageRecord {
	timestamp: number;
	modelKey: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface FileCacheEntry {
	mtimeMs: number;
	records: CachedUsageRecord[];
}

interface SessionCacheEntry extends FileCacheEntry {
	version: number;
	sessionPath: string;
}

interface UsageReportData {
	days: number;
	scannedFiles: number;
	matchedFiles: number;
	cacheHits: number;
	items: Array<{
		modelKey: string;
		calls: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cacheRate: number;
		totalTokens: number;
		cost: number;
	}>;
	totals: {
		calls: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		overallCacheRate: number;
		totalTokens: number;
		cost: number;
	};
}

const CACHE_VERSION = 2;

/**
 * Each session is persisted independently under the Pi user directory;
 * plugin updates never clean up these rebuildable caches.
 */
function getSessionCachePath(sessionFile: string): string {
	const key = createHash("sha256").update(path.resolve(sessionFile)).digest("hex");
	return path.join(cacheRoot(), "sessions", `${key}.json.gz`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileCacheEntry(value: unknown): value is FileCacheEntry {
	return isRecord(value) &&
		typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs) &&
		Array.isArray(value.records) && value.records.every((record: unknown) =>
			isRecord(record) && typeof record.modelKey === "string" &&
			["timestamp", "input", "output", "cacheRead", "cacheWrite", "cost"].every((key) =>
				typeof record[key] === "number" && Number.isFinite(record[key]),
			),
		);
}

function readSessionCache(cacheFile: string): SessionCacheEntry | undefined {
	try {
		const data: unknown = JSON.parse(gunzipSync(fs.readFileSync(cacheFile)).toString("utf-8"));
		if (
			isRecord(data) && data.version === CACHE_VERSION &&
			typeof data.sessionPath === "string" && path.isAbsolute(data.sessionPath) &&
			getSessionCachePath(data.sessionPath) === cacheFile && isFileCacheEntry(data)
		) {
			return { version: CACHE_VERSION, sessionPath: data.sessionPath, mtimeMs: data.mtimeMs, records: data.records };
		}
	} catch {
		// If a single cache is corrupted or missing, only rebuild that session.
	}
	return undefined;
}

function saveSessionCache(sessionFile: string, entry: FileCacheEntry): boolean {
	const sessionPath = path.resolve(sessionFile);
	const cacheFile = getSessionCachePath(sessionPath);
	const temporaryFile = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		const content = JSON.stringify({ version: CACHE_VERSION, sessionPath, mtimeMs: entry.mtimeMs, records: entry.records });
		fs.writeFileSync(temporaryFile, gzipSync(content), { flag: "wx" });
		if (gunzipSync(fs.readFileSync(temporaryFile)).toString("utf-8") !== content) {
			return false;
		}
		// Atomically replace after the temporary file verifies; keep the old cache on failure.
		fs.renameSync(temporaryFile, cacheFile);
		return true;
	} catch {
		return false;
	} finally {
		try {
			fs.unlinkSync(temporaryFile);
		} catch {
			// The temporary file no longer exists after a successful rename.
		}
	}
}

function pruneSessionCaches(sessionsDir: string, seenCacheFiles: Set<string>): void {
	const cacheDir = path.join(cacheRoot(), "sessions");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(cacheDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !/^[a-f0-9]{64}\.json\.gz$/.test(entry.name)) continue;
		const cacheFile = path.join(cacheDir, entry.name);
		if (seenCacheFiles.has(cacheFile)) continue;
		const cached = readSessionCache(cacheFile);
		if (!cached) continue;
		const relative = path.relative(path.resolve(sessionsDir), cached.sessionPath);
		if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) continue;
		try {
			fs.statSync(cached.sessionPath);
		} catch (error) {
			// Only clean up source files confirmed missing under the current root; a read failure is not a deletion.
			if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
				try {
					fs.unlinkSync(cacheFile);
				} catch {
					// A cleanup failure does not affect this run's statistics.
				}
			}
		}
	}
}

function resolveSessionsDir(customSessionFile?: string): string {
	if (customSessionFile) {
		try {
			return path.dirname(path.dirname(customSessionFile));
		} catch {
			// Fallback
		}
	}
	return path.join(os.homedir(), ".pi", "agent", "sessions");
}

function parseSessionFile(fullPath: string): CachedUsageRecord[] {
	const records: CachedUsageRecord[] = [];
	try {
		const content = fs.readFileSync(fullPath, "utf-8");
		const lines = content.split("\n");

		for (const line of lines) {
			if (!line.trim()) continue;

			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

			let key: string | undefined;
			let usage: any;
			let entryTs = 0;

			if (entry.timestamp) {
				entryTs = new Date(entry.timestamp).getTime();
			}

			if (entry.type === "message" && entry.message?.role === "assistant") {
				const msg = entry.message;
				const provider = msg.provider || "unknown";
				const model = msg.responseModel || msg.model || "unknown";
				key = `${provider}/${model}`;
				usage = msg.usage;
				if (!entryTs && msg.timestamp) {
					entryTs = msg.timestamp;
				}
			} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
				key = "Tools/summaries";
				usage = entry.message.usage;
				if (!entryTs && entry.message.timestamp) {
					entryTs = entry.message.timestamp;
				}
			} else if (
				(entry.type === "branch_summary" || entry.type === "compaction") &&
				entry.usage
			) {
				key = "Tools/summaries";
				usage = entry.usage;
			}

			if (!key || !usage) continue;

			records.push({
				timestamp: entryTs,
				modelKey: key,
				input: usage.input || 0,
				output: usage.output || 0,
				cacheRead: usage.cacheRead || 0,
				cacheWrite: usage.cacheWrite || 0,
				cost: usage.cost?.total || 0,
			});
		}
	} catch {
		// Ignore single-file read errors
	}
	return records;
}

function collectUsageWithCache(
	sessionsDir: string,
	cutoffMs: number,
): {
	allRecords: CachedUsageRecord[];
	scannedFiles: number;
	matchedFiles: number;
	cacheHits: number;
} {
	const seenCacheFiles = new Set<string>();
	let scannedFiles = 0;
	let matchedFiles = 0;
	let cacheHits = 0;

	const allRecords: CachedUsageRecord[] = [];

	if (!fs.existsSync(sessionsDir)) {
		return { allRecords, scannedFiles, matchedFiles, cacheHits };
	}

	const stack: string[] = [path.resolve(sessionsDir)];

	while (stack.length > 0) {
		const currentDir = stack.pop()!;
		let dirEntries: fs.Dirent[];
		try {
			dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const dirent of dirEntries) {
			const fullPath = path.join(currentDir, dirent.name);
			if (dirent.isDirectory()) {
				stack.push(fullPath);
			} else if (dirent.isFile() && dirent.name.endsWith(".jsonl")) {
				scannedFiles++;
				const cacheFile = getSessionCachePath(fullPath);
				seenCacheFiles.add(cacheFile);

				let stat: fs.Stats;
				try {
					stat = fs.statSync(fullPath);
				} catch {
					continue;
				}

				// First pruning layer: if the file's mtime predates the cutoff, the file cannot contain new records within the window
				if (cutoffMs > 0 && stat.mtimeMs < cutoffMs) {
					continue;
				}

				let fileRecords: CachedUsageRecord[];
				const cached = readSessionCache(cacheFile);

				// Second pruning layer: if the file's mtime is unchanged, hit the incremental cache directly
				if (cached && cached.mtimeMs === stat.mtimeMs) {
					fileRecords = cached.records;
					cacheHits++;
				} else {
					fileRecords = parseSessionFile(fullPath);
					saveSessionCache(fullPath, {
						mtimeMs: stat.mtimeMs,
						records: fileRecords,
					});
				}

				let hasFileMatch = false;
				for (const record of fileRecords) {
					if (cutoffMs > 0 && record.timestamp > 0 && record.timestamp < cutoffMs) {
						continue;
					}
					allRecords.push(record);
					hasFileMatch = true;
				}

				if (hasFileMatch) {
					matchedFiles++;
				}
			}
		}
	}

	pruneSessionCaches(sessionsDir, seenCacheFiles);

	return { allRecords, scannedFiles, matchedFiles, cacheHits };
}

/**
 * Magnitude unit formatting: convert to k, m, b at the corresponding magnitude
 * - < 1,000: output as-is
 * - 1,000 ~ 999,999: convert to k (e.g. 1.5k, 45.2k, 850k)
 * - 1,000,000 ~ 999,999,999: convert to m (e.g. 1.25m, 14.5m, 120m)
 * - >= 1,000,000,000: convert to b (e.g. 1.05b, 12.3b, 150b)
 */
function formatNumber(count: number): string {
	if (count === 0) return "0";
	if (count < 1000) return count.toString();
	if (count < 1_000_000) {
		const val = count / 1000;
		const str = val >= 100 ? Math.round(val).toString() : val.toFixed(1).replace(/\.0$/, "");
		return `${str}k`;
	}
	if (count < 1_000_000_000) {
		const val = count / 1_000_000;
		const str =
			val >= 100
				? Math.round(val).toString()
				: val >= 10
					? val.toFixed(1).replace(/\.0$/, "")
					: val.toFixed(2).replace(/\.?0+$/, "");
		return `${str}m`;
	}
	const val = count / 1_000_000_000;
	const str =
		val >= 100
			? Math.round(val).toString()
			: val >= 10
				? val.toFixed(1).replace(/\.0$/, "")
				: val.toFixed(2).replace(/\.?0+$/, "");
	return `${str}b`;
}

function formatCost(cost: number): string {
	if (cost === 0) return "$0.00";
	if (cost < 0.01) return `$${cost.toFixed(3)}`;
	if (cost < 1000) return `$${cost.toFixed(2)}`;
	if (cost < 1_000_000) {
		const k = cost / 1000;
		return `$${k.toFixed(1).replace(/\.0$/, "")}k`;
	}
	const m = cost / 1_000_000;
	return `$${m.toFixed(2).replace(/\.?0+$/, "")}m`;
}

function renderUsageReport(data: UsageReportData, theme: Theme, width = 100): Text {
	const pad = (text: string, size: number, left = false) => {
		const spaces = " ".repeat(Math.max(0, size - visibleWidth(text)));
		return left ? spaces + text : text + spaces;
	};
	const timeLabel = data.days > 0 ? t("usage.recentDays", { days: data.days }) : t("usage.allHistory");
	let output = `${theme.bold(theme.fg("accent", `── ${t("legacy.title")}`))} ${theme.fg("dim", `(${timeLabel}) ──`)}\n\n`;

	if (data.items.length === 0) {
		output += `${theme.fg("dim", t("legacy.empty", { period: timeLabel }))}`;
		return new Text(output, 1, 0);
	}

	if (width < 100) {
		const rows = [
			...data.items,
			{ ...data.totals, modelKey: t("column.total"), cacheRate: data.totals.overallCacheRate },
		];
		for (const item of rows) {
			output += `${theme.bold(theme.fg("accent", item.modelKey))}\n`;
			output += `${t("column.calls")} ${formatNumber(item.calls)} | ${t("column.input")} ${formatNumber(item.input)} | ${t("column.output")} ${formatNumber(item.output)}\n`;
			output += `${t("column.cacheRead")} ${formatNumber(item.cacheRead)} | ${t("column.cacheWrite")} ${formatNumber(item.cacheWrite)} | ${t("column.cacheRate")} ${item.cacheRate.toFixed(1)}%\n`;
			output += `${t("column.tokens")} ${formatNumber(item.totalTokens)} | ${theme.fg("warning", formatCost(item.cost))}\n\n`;
		}
		output += theme.fg("dim", t("legacy.scan", { scanned: data.scannedFiles, hits: data.cacheHits, matched: data.matchedFiles }));
		return new Text(output, 1, 0);
	}

	const colModel = 30;
	const colCalls = 6;
	const colInput = 8;
	const colOutput = 8;
	const colCacheR = 9;
	const colCacheW = 9;
	const colRate = 8;
	const colTokens = 9;
	const colCost = 8;

	const header =
		pad(t("column.model"), colModel) +
		pad(t("column.calls"), colCalls, true) +
		pad(t("column.input"), colInput, true) +
		pad(t("column.output"), colOutput, true) +
		pad(t("column.cacheRead"), colCacheR, true) +
		pad(t("column.cacheWrite"), colCacheW, true) +
		pad(t("column.cacheRate"), colRate, true) +
		pad(t("column.tokens"), colTokens, true) +
		pad(t("column.cost"), colCost, true);

	output += theme.bold(header) + "\n";
	output += theme.fg("dim", "─".repeat(visibleWidth(header))) + "\n";

	for (const item of data.items) {
		const modelStr = truncateToWidth(item.modelKey, colModel - 2, "…");

		const rateStr = `${item.cacheRate.toFixed(1)}%`;
		const rateFormatted =
			item.cacheRate > 50
				? theme.fg("success", rateStr.padStart(colRate))
				: item.cacheRate > 0
					? theme.fg("accent", rateStr.padStart(colRate))
					: theme.fg("dim", rateStr.padStart(colRate));

		const row =
			theme.fg("text", modelStr + " ".repeat(Math.max(0, colModel - visibleWidth(modelStr)))) +
			theme.fg("dim", formatNumber(item.calls).padStart(colCalls)) +
			formatNumber(item.input).padStart(colInput) +
			formatNumber(item.output).padStart(colOutput) +
			theme.fg("accent", formatNumber(item.cacheRead).padStart(colCacheR)) +
			theme.fg("dim", formatNumber(item.cacheWrite).padStart(colCacheW)) +
			rateFormatted +
			theme.bold(formatNumber(item.totalTokens).padStart(colTokens)) +
			theme.fg("warning", formatCost(item.cost).padStart(colCost));

		output += row + "\n";
	}

	output += theme.fg("dim", "─".repeat(visibleWidth(header))) + "\n";

	// Totals row
	const totRateStr = `${data.totals.overallCacheRate.toFixed(1)}%`;
	const totRateFormatted =
		data.totals.overallCacheRate > 50
			? theme.fg("success", totRateStr.padStart(colRate))
			: theme.fg("accent", totRateStr.padStart(colRate));

	const totalRow =
		theme.bold(pad(t("column.total"), colModel)) +
		theme.bold(formatNumber(data.totals.calls).padStart(colCalls)) +
		theme.bold(formatNumber(data.totals.input).padStart(colInput)) +
		theme.bold(formatNumber(data.totals.output).padStart(colOutput)) +
		theme.bold(formatNumber(data.totals.cacheRead).padStart(colCacheR)) +
		theme.bold(formatNumber(data.totals.cacheWrite).padStart(colCacheW)) +
		totRateFormatted +
		theme.bold(formatNumber(data.totals.totalTokens).padStart(colTokens)) +
		theme.bold(theme.fg("warning", formatCost(data.totals.cost).padStart(colCost)));

	output += totalRow + "\n\n";
	output += theme.fg(
		"dim",
		t("legacy.scanDetailed", { scanned: data.scannedFiles, hits: data.cacheHits, matched: data.matchedFiles }),
	);

	return new Text(output, 1, 0);
}

export default function usageExtension(pi: ExtensionAPI) {
	pi.registerEntryRenderer<UsageReportData>("usage", (entry, _options, theme) => {
		return entry.data ? renderUsageReport(entry.data, theme) : undefined;
	});

	// Register the /m-usg command
	pi.registerCommand("m-usg", {
		description: t("legacy.description"),
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "7", label: t("legacy.days7") },
				{ value: "14", label: t("legacy.days14") },
				{ value: "30", label: t("legacy.days30") },
				{ value: "all", label: t("legacy.all") },
			];
			const filtered = options.filter((opt) => opt.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(t("usage.requiresUI"), "warning");
				return;
			}
			let days = 7;
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "all" || trimmed === "0") {
				days = 0;
			} else if (trimmed) {
				const parsed = parseInt(trimmed, 10);
				if (isNaN(parsed) || parsed < 0) {
					if (ctx.hasUI) {
						ctx.ui.notify(t("legacy.invalidArgs"), "warning");
					}
					return;
				}
				days = parsed;
			}

			const cutoffMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const sessionsDir = resolveSessionsDir(currentSessionFile);

			const { allRecords, scannedFiles, matchedFiles, cacheHits } = collectUsageWithCache(
				sessionsDir,
				cutoffMs,
			);

			// Aggregate and summarize
			const modelMap = new Map<
				string,
				{
					calls: number;
					input: number;
					output: number;
					cacheRead: number;
					cacheWrite: number;
					cost: number;
				}
			>();

			let totalCalls = 0;
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const r of allRecords) {
				let s = modelMap.get(r.modelKey);
				if (!s) {
					s = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					modelMap.set(r.modelKey, s);
				}
				s.calls += 1;
				s.input += r.input;
				s.output += r.output;
				s.cacheRead += r.cacheRead;
				s.cacheWrite += r.cacheWrite;
				s.cost += r.cost;

				totalCalls += 1;
				totalInput += r.input;
				totalOutput += r.output;
				totalCacheRead += r.cacheRead;
				totalCacheWrite += r.cacheWrite;
				totalCost += r.cost;
			}

			const items = Array.from(modelMap.entries())
				.map(([modelKey, s]) => {
					const promptTokens = s.input + s.cacheRead + s.cacheWrite;
					const cacheRate = promptTokens > 0 ? (s.cacheRead / promptTokens) * 100 : 0;
					const totalTokens = promptTokens + s.output;

					return {
						modelKey,
						calls: s.calls,
						input: s.input,
						output: s.output,
						cacheRead: s.cacheRead,
						cacheWrite: s.cacheWrite,
						cacheRate,
						totalTokens,
						cost: s.cost,
					};
				})
				.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);

			const totalPrompt = totalInput + totalCacheRead + totalCacheWrite;
			const overallCacheRate = totalPrompt > 0 ? (totalCacheRead / totalPrompt) * 100 : 0;

			const reportData: UsageReportData = {
				days,
				scannedFiles,
				matchedFiles,
				cacheHits,
				items,
				totals: {
					calls: totalCalls,
					input: totalInput,
					output: totalOutput,
					cacheRead: totalCacheRead,
					cacheWrite: totalCacheWrite,
					overallCacheRate,
					totalTokens: totalPrompt + totalOutput,
					cost: totalCost,
				},
			};

			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				const scroll = new ScrollView({
					invalidate() {},
					render: (width: number) => renderUsageReport(reportData, theme, width).render(width),
				}, { overscroll: "contain" });
				let closed = false;
				return {
					invalidate: () => scroll.invalidate(),
					handleInput(data: string) {
						if (closed) return;
						if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) {
							closed = true;
							done();
						} else if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
						else if (keybindings.matches(data, "tui.select.down")) scroll.scrollBy(1);
						else if (keybindings.matches(data, "tui.select.pageUp")) scroll.scrollBy(-scroll.viewportHeight);
						else if (keybindings.matches(data, "tui.select.pageDown")) scroll.scrollBy(scroll.viewportHeight);
						else if (keybindings.matches(data, "tui.altScreen.top")) scroll.scrollToStart();
						else if (keybindings.matches(data, "tui.altScreen.bottom")) scroll.scrollToEnd();
					},
					handleMouse(event: TuiMouseEvent) {
						if (event.type === "wheel") {
							scroll.scrollBy(event.wheelDelta ?? 0);
							return { handled: true };
						}
						return undefined;
					},
					render(width: number): string[] {
						if (width <= 0) return [""];
						const maxHeight = Math.max(1, Math.min(tui.terminal.rows - 2, Math.floor(tui.terminal.rows * 0.8)));
						const framed = width >= 5 && maxHeight >= 3;
						const innerWidth = framed ? width - 4 : width;
						const lines = scroll.render(innerWidth);
						const pageSize = Math.max(1, Math.min(lines.length, maxHeight - (framed ? 2 : 0)));
						scroll.updateLayout(lines.length, pageSize, () => tui.requestRender());
						const visible = lines.slice(scroll.scrollTop, scroll.scrollTop + pageSize);
						if (!framed) return visible.map((line) => truncateToWidth(line, width, ""));
						const border = (text: string) => theme.fg("accent", text);
						const result = [border(`┌${"─".repeat(width - 2)}┐`)];
						for (const line of visible) {
							const text = truncateToWidth(line, innerWidth, "");
							result.push(`${border("│")} ${text}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))} ${border("│")}`);
						}
						const position = ` ${scroll.scrollTop + 1}-${scroll.scrollTop + visible.length} / ${lines.length} `;
						const footer = lines.length > pageSize && visibleWidth(position) <= width - 4
							? `${"─".repeat(width - 3 - visibleWidth(position))}${position}─`
							: "─".repeat(width - 2);
						result.push(border(`└${footer}┘`));
						return result;
					},
				};
			}, { overlay: true, overlayOptions: { width: 112, maxHeight: "80%", margin: 1, anchor: "center" } });
		},
	});
}
