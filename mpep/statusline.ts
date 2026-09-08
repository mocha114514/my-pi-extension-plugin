import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { t } from "./shared/i18n/index.ts";
import { isPluginEnabled } from "./manager/preferences.ts";

const execFileAsync = promisify(execFile);

// ── ANSI Colors (high-contrast bright colors, consistent with statusline.py) ──
const CYAN = "\x1b[96m"; // Model name and right-side info
const GREEN = "\x1b[92m"; // Project root directory
const BLUE = "\x1b[94m"; // Current relative directory
const YELLOW = "\x1b[93m"; // Normal token display
const LIGHT_PINK = "\x1b[38;2;255;182;193m"; // Git branch and status
const GRAY = "\x1b[90m"; // Separator
const ORANGE = "\x1b[38;5;214m"; // Context warning (>80%)
const RED_BRIGHT = "\x1b[91m"; // Context danger (>95%)
const RESET = "\x1b[0m";

const MODEL_WIDGET_KEY = "model-info";
const REFRESH_INTERVAL_MS = 1000;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatContextTokens(count: number): string {
	if (count <= 0) return "0k";
	if (count < 1000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

export default function (pi: ExtensionAPI) {
	if (!isPluginEnabled("statusline")) return;
	let cachedGitStatus: string | null = null;
	let projectRoot: string = process.cwd();

	// Asynchronously update detailed Git status (branch name + M/A/D/? counts)
	async function updateGitStatus(cwd: string) {
		try {
			const { stdout: rootOut } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
			projectRoot = rootOut.trim() || cwd;

			const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
			const branch = branchOut.trim();

			const { stdout: porcelain } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
			let modified = 0;
			let added = 0;
			let deleted = 0;
			let untracked = 0;

			for (const line of porcelain.split("\n")) {
				if (!line || line.length < 2) continue;
				const xy = line.slice(0, 2);
				if (xy === "??") untracked++;
				else {
					if (xy.includes("M")) modified++;
					if (xy.includes("A")) added++;
					if (xy.includes("D")) deleted++;
				}
			}

			const tokens = [branch];
			if (modified) tokens.push(`M${modified}`);
			if (added) tokens.push(`A${added}`);
			if (deleted) tokens.push(`D${deleted}`);
			if (untracked) tokens.push(`?${untracked}`);

			cachedGitStatus = tokens.length === 1 ? `${branch} ✓` : tokens.join(" ● ");
		} catch {
			cachedGitStatus = null;
			projectRoot = cwd;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		void updateGitStatus(ctx.cwd);

		const ui = ctx.ui;
		ui.setFooter((tui, _theme, footerData) => {
			ui.setWidget(
				MODEL_WIDGET_KEY,
				() => ({
					invalidate() {},
					render(width: number): string[] {
						if (width <= 0) return [""];

						const model = ctx.model;
						let label = model?.id || t("status.noModel");
						if (model?.reasoning) {
							const thinkingLevel = ctx.thinkingLevel || "off";
							label += thinkingLevel === "off" ? ` • ${t("status.thinkingOff")}` : ` • ${thinkingLevel}`;
						}
						if (footerData.getAvailableProviderCount() > 1 && model) {
							label = `(${model.provider}) ${label}`;
						}

						const text = truncateToWidth(label.replace(/[\r\n\t]/g, " "), width, "...".slice(0, width));
						const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
						return [`${padding}${CYAN}${text}${RESET}`];
					},
				}),
				{ placement: "aboveEditor" },
			);

			// Reactively listen for branch switches and refresh automatically
			const unsubBranch = footerData.onBranchChange(() => {
				void updateGitStatus(ctx.cwd).then(() => tui.requestRender());
			});

			// Refresh the status bar once per second.
			const refreshTimer = setInterval(() => {
				tui.requestRender();
			}, REFRESH_INTERVAL_MS);
			refreshTimer.unref();

			return {
				dispose() {
					unsubBranch();
					clearInterval(refreshTimer);
					ui.setWidget(MODEL_WIDGET_KEY, undefined);
				},
				invalidate() {},
				render(width: number): string[] {
					// ── 1. Aggregate cumulative tokens (keep top five: ↑input ↓output Rcache-read Wcache-write CH hit-rate) ──
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const u = entry.message.usage;
							if (u) {
								input += u.input || 0;
								output += u.output || 0;
								cacheRead += u.cacheRead || 0;
								cacheWrite += u.cacheWrite || 0;
								const promptTokens = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
								if (promptTokens > 0) {
									latestCacheHitRate = ((u.cacheRead || 0) / promptTokens) * 100;
								}
							}
						} else if (
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.usage
						) {
							const u = entry.message.usage;
							input += u.input || 0;
							output += u.output || 0;
							cacheRead += u.cacheRead || 0;
							cacheWrite += u.cacheWrite || 0;
						} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
							const u = entry.usage;
							input += u.input || 0;
							output += u.output || 0;
							cacheRead += u.cacheRead || 0;
							cacheWrite += u.cacheWrite || 0;
						}
					}

					const totalPromptTokens = input + cacheRead + cacheWrite;
					const overallCacheHitRate =
						totalPromptTokens > 0 ? (cacheRead / totalPromptTokens) * 100 : undefined;

					const tokenParts: string[] = [];
					if (input) tokenParts.push(`↑${formatTokens(input)}`);
					if (output) tokenParts.push(`↓${formatTokens(output)}`);
					const cacheParts: string[] = [`R${formatTokens(cacheRead)}`];
					if (cacheWrite) cacheParts.push(`W${formatTokens(cacheWrite)}`);
					const latestHitText = latestCacheHitRate === undefined ? "?" : `${latestCacheHitRate.toFixed(1)}%`;
					const overallHitText = overallCacheHitRate === undefined ? "?" : `${overallCacheHitRate.toFixed(1)}%`;
					cacheParts.push(`CH${latestHitText}(avg ${overallHitText})`);

					const cumulativeStr = tokenParts.length > 0 ? tokenParts.join(" ") : "↑0 ↓0";

					// ── 2. Context window stats (compact k format with alert colors) ──
					const contextUsage = ctx.getContextUsage();
					const usedTokens = contextUsage?.tokens;
					const maxTokens = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const pct = contextUsage?.percent;

					const usedStr = usedTokens == null ? "?" : formatContextTokens(usedTokens);
					const maxStr = formatContextTokens(maxTokens);
					const pctStr = pct == null ? "?" : `${pct.toFixed(1)}%`;
					const contextText = `${usedStr} / ${maxStr} tokens (${pctStr})`;

					let contextColor = YELLOW;
					if (pct != null && pct > 95) {
						contextColor = RED_BRIGHT;
					} else if (pct != null && pct > 80) {
						contextColor = ORANGE;
					}

					// ── 3. Line 1: project root | relative path ──
					const currentCwd = ctx.cwd;
					let relDir = relative(projectRoot, currentCwd).replace(/\\/g, "/");
					if (!relDir || relDir === "") relDir = ".";

					const sessionName = ctx.sessionManager.getSessionName();
					const relDirDisplay = sessionName ? `${relDir} • ${sessionName}` : relDir;

					const line1Left = [
						`${GREEN}${projectRoot}${RESET}`,
						`${BLUE}${relDirDisplay}${RESET}`,
					].join(` ${GRAY}|${RESET} `);

					// ── 4. Line 2: input/output • cache • context tokens | Git status ──
					const usageParts = [
						`${YELLOW}${cumulativeStr}${RESET}`,
						`${YELLOW}${cacheParts.join(" ")}${RESET}`,
						`${contextColor}${contextText}${RESET}`,
					];
					const line2LeftParts = [usageParts.join(` ${GRAY}•${RESET} `)];
					if (cachedGitStatus) {
						line2LeftParts.push(`${LIGHT_PINK}${cachedGitStatus}${RESET}`);
					}

					const line2Left = line2LeftParts.join(` ${GRAY}|${RESET} `);

					const line1 = truncateToWidth(line1Left, width, "...");
					const line2 = truncateToWidth(line2Left, width, "...");

					const lines = [line1, line2];

					// Support text set by other extensions via ctx.ui.setStatus
					const extStatuses = footerData.getExtensionStatuses();
					if (extStatuses.size > 0) {
						const sorted = Array.from(extStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
						lines.push(truncateToWidth(sorted.join(" "), width, "..."));
					}

					return lines;
				},
			};
		});
	});

	// When an agent round finishes, asynchronously re-probe git status to reflect changes
	pi.on("agent_settled", (_event, ctx) => {
		void updateGitStatus(ctx.cwd);
	});
}
