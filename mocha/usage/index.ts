import { t } from "../shared/i18n/index.ts";
import { isPluginEnabled } from "../mocha-manager/preferences.ts";
import { getMochaDir } from "../shared/paths.ts";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { isObject, parseDays } from "./data.ts";
import { UsageLedger } from "./ledger.ts";
import { PriceSync } from "./price-sync.ts";
import { loadPrices, refreshPrices, savePrices } from "./pricing.ts";
import { currentOwner } from "./process/index.ts";
import { Recorder } from "./recorder.ts";
import type { UsageRow } from "./types.ts";
import { UsageJob, UsageUI } from "./ui.ts";

export default function usageExtension(pi: ExtensionAPI): void {
	if (!isPluginEnabled("usage")) return;
	const root = join(getMochaDir(), "usage");
	const modelsFile = join(getAgentDir(), "models.json");
	let activeContext: ExtensionContext | undefined;
	const sync = new PriceSync(root, modelsFile, async () => {
		if (activeContext) await refreshPrices(pi, activeContext);
	});
	const ui = new UsageUI((ctx) => ({
		load: (target) =>
			loadPrices(
				modelsFile,
				target,
				ctx.modelRegistry.find(target.provider, target.model)?.cost,
			),
		save: async (target, prices) => {
			await savePrices(modelsFile, target, prices);
			try {
				await sync.refreshLocal();
			} finally {
				sync.notifyPeers((count) =>
					ctx.ui.notify(t("usage.peerRefreshFailed", { count }), "warning"),
				);
			}
		},
	}));
	let recorder: Recorder | undefined;
	let starting: Promise<void> | undefined;
	let job: UsageJob | undefined;
	let stopped = false;
	const summaries = new Set<string>();

	const start = (ctx: ExtensionContext) => {
		activeContext = ctx;
		starting ??= (async () => {
			const owner = await currentOwner();
			const endpoint = await sync.start().catch(() => {
				ctx.ui.notify(t("usage.receiverFailed"), "warning");
				return undefined;
			});
			recorder = new Recorder(root, owner, undefined, endpoint);
			await recorder.start();
		})().catch(error => { starting = undefined; throw error; });
		return starting;
	};

	const record = async (
		usage: unknown,
		kind: string,
		provider: string,
		model: string,
		timestamp: number,
		ctx: ExtensionContext,
	) => {
		if (stopped || !isObject(usage)) return;
		try {
			await start(ctx);
			const numeric = (value: unknown) =>
				typeof value === "number" && Number.isFinite(value) && value >= 0
					? value
					: 0;
			const row: UsageRow = {
				type: "usage",
				timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
				kind,
				provider,
				model,
				calls: 1,
				input: numeric(usage.input),
				output: numeric(usage.output),
				cacheRead: numeric(usage.cacheRead),
				cacheWrite: numeric(usage.cacheWrite),
				cost: numeric(isObject(usage.cost) ? usage.cost.total : 0),
			};
			await recorder?.append(row);
		} catch (error) {
			ctx.ui.notify(t("usage.recordFailed", { error: String(error) }), "error");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			await start(ctx);
		} catch (error) {
			ctx.ui.notify(t("usage.initFailed", { error: String(error) }), "error");
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role === "assistant") {
			await record(
				message.usage,
				"assistant",
				message.provider,
				message.responseModel ?? message.model,
				message.timestamp,
				ctx,
			);
		} else if (message.role === "toolResult" && message.usage) {
			await record(
				message.usage,
				"tool",
				"Tools",
				"summaries",
				message.timestamp,
				ctx,
			);
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		const entry = event.compactionEntry;
		if (!entry.usage || summaries.has(entry.id)) return;
		summaries.add(entry.id);
		await record(
			entry.usage,
			"compaction",
			"Tools",
			"summaries",
			Date.parse(entry.timestamp),
			ctx,
		);
	});

	pi.on("session_tree", async (event, ctx) => {
		const entry = event.summaryEntry;
		if (!entry?.usage || summaries.has(entry.id)) return;
		summaries.add(entry.id);
		await record(
			entry.usage,
			"branch",
			"Tools",
			"summaries",
			Date.parse(entry.timestamp),
			ctx,
		);
	});

	pi.on("session_shutdown", async () => {
		stopped = true;
		ui.dispose();
		await starting?.catch(() => {});
		await ui.settled();
		await sync.close();
		await job?.promise;
		await recorder?.close();
	});

	pi.registerCommand("m-usg", {
		description: t("usage.description"),
		getArgumentCompletions: (prefix) => {
			const values = ["7", "14", "30", "all"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return values.length ? values : null;
		},
		handler: async (args, ctx) => {
			try {
				const days = parseDays(args);
				if (!ctx.hasUI) {
					ctx.ui.notify(t("usage.requiresUI"), "warning");
					return;
				}
				if (!job || job.complete) {
					job = new UsageJob(
						new UsageLedger(root),
						start(ctx).then(() => recorder?.flush()),
					);
					ui.watch(job, ctx);
				}
				await ui.show(job, ctx, days);
			} catch (error) {
				ctx.ui.notify(String(error), "error");
			}
		},
	});
}
