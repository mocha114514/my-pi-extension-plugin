import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { t } from "../shared/i18n/index.ts";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { createEditorStatus } from "./editor-status.ts";
import { collectTurns, elapsedForTurn, formatElapsed } from "./history.ts";
import { selectViewportTurn } from "./viewport.ts";

export function createCookedWidget(tui: TUI, ctx: ExtensionContext, working: () => boolean): Component & { dispose(): void; refresh(): void } {
	let text = "";
	let reserveRow = false;
	let pending = false;
	let disposed = false;
	const border = createEditorStatus(tui, () => !working() && text ? ctx.ui.theme.fg("dim", text) : "");
	return {
		render(width) {
			if (disposed) return [];
			const embedded = border.sync();
			if (working()) return [];
			if (!pending) {
				pending = true;
				// Widget measurement can precede transcript layout. Read once after the
				// entire render finishes, so resize/folding/navigation use the same geometry.
				queueMicrotask(() => {
					pending = false;
					if (disposed || working()) return;
					const entries = ctx.sessionManager.getBranch();
					const turns = collectTurns(entries);
					const elapsed = elapsedForTurn(selectViewportTurn(tui, entries, turns));
					const next = elapsed === undefined ? "" : t("timer.cooked", { elapsed: formatElapsed(elapsed / 1000) });
					// Keep the dock height stable while browsing unknown/incomplete rounds;
					// otherwise adding this line can itself change the center-nearest round.
					const nextReserve = turns.length > 0;
					if (next === text && nextReserve === reserveRow) return;
					text = next;
					reserveRow = nextReserve;
					tui.requestRender();
				});
			}
			return reserveRow && !embedded ? [text ? truncateToWidth(` ${ctx.ui.theme.fg("dim", text)}`, Math.max(1, width)) : ""] : [];
		},
		invalidate() {},
		refresh() { text = ""; tui.requestRender(); },
		dispose() { disposed = true; text = ""; border.dispose(); },
	};
}
