import { t } from "../shared/i18n/index.ts";
import { CompactionSummaryMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Container, Markdown, MouseRegion, Spacer, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { installActivityComponents } from "./activity_components.ts";
import { installCompactionPlacement } from "./compaction_placement.ts";
import { isCompactionDoubleClick, isPaddedLineBlank } from "./mouse_interaction_handler.ts";
import { safeThemeBold, safeThemeFg } from "./summary_preview_renderer.ts";

const patchSlot = Symbol.for("mpep.turn-fold.patches");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;
export function applyPatches(): () => void {
	patches[patchSlot]?.();
	const disposeActivity = installActivityComponents();
	const disposePlacement = installCompactionPlacement();
	const compactionPrototype = CompactionSummaryMessageComponent.prototype as unknown as Container & {
		updateDisplay(): void;
		handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]>;
	};
	const originalCompaction = compactionPrototype.updateDisplay;
	const originalMouse = compactionPrototype.handleMouse;
	// ── Hook into CompactionSummaryMessageComponent: colorless single-line collapse/expand for compaction events ──
	if (CompactionSummaryMessageComponent?.prototype) {
		compactionPrototype.updateDisplay = function () {
			(this as any).paddingX = 0;
			(this as any).paddingY = 0;
			(this as any).bgFn = undefined;
			this.clear();

			const message = (this as any).message;
			const tokenStr = message?.tokensBefore != null ? message.tokensBefore.toLocaleString() : "...";

			const title = safeThemeFg("toolTitle", safeThemeBold(t("activity.compaction")));
			const count = safeThemeFg("accent", t("activity.tokens", { count: tokenStr }));
			const hint = safeThemeFg("muted", t("activity.expandHint"));
			const summaryLine = `${title} • ${count}${hint}`;

			const isExpanded = Boolean((this as any).expanded);

			const headerRegion = new MouseRegion(new Text(summaryLine, 0, 0), (event) => {
				if (event?.button === "left") {
					if (event.type === "press") return { handled: true };
					if (event.type === "click") {
						if (isCompactionDoubleClick(this, event)) (this as any).setExpanded(!isExpanded);
						return { handled: true };
					}
				}
				return undefined;
			});
			this.addChild(headerRegion);
			if (isExpanded) {
				this.addChild(new Spacer(1));

				const summary = message?.summary || "";
				const header = t("activity.compacted", { count: tokenStr });
				const mdComp = new Markdown(header + summary, 0, 0, (this as any).markdownTheme, {
					color: (text: string) => safeThemeFg("customMessageText", text),
				});
				const mdRegion = new MouseRegion(mdComp, (event) => {
					if (event?.button !== "left") return undefined;
					const line = mdComp.render(event.width || 80)[event.y] ?? "";
					if (!isPaddedLineBlank(line, event.x)) return undefined;
					if (event.type === "press") return { handled: true };
					if (event.type === "click") {
						if (isCompactionDoubleClick(this, event)) (this as any).setExpanded(false);
						return { handled: true };
					}
					return undefined;
				});
				this.addChild(mdRegion);
			}
		};
	}
	compactionPrototype.handleMouse = function (event: TuiMouseEvent) {
		const result = originalMouse?.call(this, event);
		if (result) return result;
		if (!Boolean((this as any).expanded) || event.button !== "left") return undefined;
		const line = this.render(event.width)[event.y] ?? "";
		if (!isPaddedLineBlank(line, event.x)) return undefined;
		const target = {
			component: this,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		};
		if (event.type === "press") return { handled: true, target };
		if (event.type === "click") {
			if (isCompactionDoubleClick(this, event)) (this as any).setExpanded(false);
			return { handled: true, target };
		}
		return undefined;
	};
	const installedCompaction = compactionPrototype.updateDisplay;
	const installedMouse = compactionPrototype.handleMouse;
	const dispose = () => {
		disposeActivity();
		disposePlacement();
		if (compactionPrototype.updateDisplay === installedCompaction)
			compactionPrototype.updateDisplay = originalCompaction;
		if (compactionPrototype.handleMouse === installedMouse) compactionPrototype.handleMouse = originalMouse;
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
