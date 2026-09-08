import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { installNavigator } from "./viewport-adapter.ts";

const SLOT = Symbol.for("mpep.turn-navigator.dispose");
const BRIDGE = "turn-navigator-bridge";
const installations = globalThis as unknown as Record<symbol, (() => void) | undefined>;

export default function turnNavigator(pi: ExtensionAPI): void {
	if (!isPluginEnabled("turn-navigator")) return;
	installations[SLOT]?.();
	let navigator: ReturnType<typeof installNavigator> | undefined;
	const dispose = () => {
		navigator?.dispose();
		navigator = undefined;
		if (installations[SLOT] === dispose) delete installations[SLOT];
	};
	installations[SLOT] = dispose;
	pi.on("session_start", (_event, ctx) => {
		navigator?.dispose();
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		navigator = installNavigator({
			theme: () => ctx.ui.theme,
			error: (message) => ctx.ui.notify(message, "warning"),
		});
		// Capture the host without replacing another extension's editor or footer.
		ctx.ui.setWidget(BRIDGE, (tui) => {
			navigator?.attach(tui);
			return { render: () => [], invalidate() {} };
		});
		ctx.ui.setWidget(BRIDGE, undefined);
	});
	pi.on("session_shutdown", dispose);
}
