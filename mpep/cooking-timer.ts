import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatElapsed } from "./cooking-timer/history.ts";
import { createCookedWidget } from "./cooking-timer/widget.ts";
import { t } from "./shared/i18n/index.ts";
import { isPluginEnabled } from "./manager/preferences.ts";

const COOKING_FRAMES = [".", ".", "·", "·", "∘", "∘", "°", "o", "o", "O", "O"];
const FRAME_INTERVAL_MS = 120;
const SHIMMER_INTERVAL_MS = 80;
const WIDGET_KEY = "cooked-duration";
const SLOT = Symbol.for("mpep.cooking-timer.dispose");
const installations = globalThis as unknown as Record<symbol, (() => void) | undefined>;

export default function (pi: ExtensionAPI) {
	if (!isPluginEnabled("cooking-timer")) return;
	installations[SLOT]?.();
	let timer: ReturnType<typeof setInterval> | null = null;
	let startTime = 0;
	let working = false;
	let context: ExtensionContext | undefined;
	let widget: ReturnType<typeof createCookedWidget> | undefined;

	function stopCooking(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (ctx.hasUI && ctx.mode === "tui") {
			// Restore Pi's default indicator and message
			ctx.ui.setWorkingIndicator();
			ctx.ui.setWorkingMessage();
		}
	}

	function dispose() {
		if (context) {
			stopCooking(context);
			widget?.dispose();
			context.ui.setWidget(WIDGET_KEY, undefined);
		}
		widget = undefined;
		context = undefined;
		working = false;
		if (installations[SLOT] === dispose) delete installations[SLOT];
	}
	installations[SLOT] = dispose;

	function mount(ctx: ExtensionContext) {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		context = ctx;
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			widget = createCookedWidget(tui, ctx, () => working);
			return widget;
		});
	}

	function startCooking(ctx: ExtensionContext) {
		stopCooking(ctx);
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (!widget) mount(ctx);

		// Retries can emit another agent_start before agent_settled. Keep that round's clock.
		if (!working) startTime = Date.now();
		working = true;
		widget?.refresh();

		ctx.ui.setWorkingIndicator({
			frames: COOKING_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: FRAME_INTERVAL_MS,
		});

		const updateMessage = () => {
			const cookingLabel = t("timer.cooking");
			const elapsedMs = Math.max(0, Date.now() - startTime);
			// Let the highlight enter and leave the word before starting the next sweep.
			const highlight = Math.floor(elapsedMs / SHIMMER_INTERVAL_MS) % (cookingLabel.length + 5) - 2;
			const theme = ctx.ui.theme;
			const label = [...cookingLabel]
				.map((letter, index) => {
					const distance = Math.abs(index - highlight);
					// Keep the sweep neutral regardless of the theme's accent and text colors.
					const brightness = distance === 0 ? 255 : distance === 1 ? 208 : 128;
					return `\x1b[38;2;${brightness};${brightness};${brightness}m${letter}\x1b[39m`;
				})
				.join("");
			ctx.ui.setWorkingMessage(`${label} ${theme.fg("muted", formatElapsed(Math.floor(elapsedMs / 1000)))}`);
		};
		updateMessage();
		timer = setInterval(updateMessage, SHIMMER_INTERVAL_MS);
		timer.unref();
	}

	pi.on("session_start", (_event, ctx) => {
		dispose();
		installations[SLOT] = dispose;
		mount(ctx);
	});

	pi.on("message_start", (event) => {
		// Queued follow-ups/steering become a new user round when consumed, not when typed.
		if (working && event.message.role === "user") startTime = Date.now();
	});

	// Listen for AI task start events
	pi.on("agent_start", async (_event, ctx) => {
		startCooking(ctx);
	});

	// Listen for task end/termination events
	pi.on("agent_end", async (_event, ctx) => {
		stopCooking(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		working = false;
		stopCooking(ctx);
		widget?.refresh();
	});

	pi.on("session_tree", () => widget?.refresh());
	pi.on("session_compact", () => widget?.refresh());
	pi.on("session_shutdown", dispose);
}
