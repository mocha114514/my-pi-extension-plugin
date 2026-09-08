import { t } from "../shared/i18n/index.ts";
import { CompactionSummaryMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Container, Markdown, MouseRegion, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { installActivityComponents } from "./activity_components.ts";
import { isCompactionDoubleClick } from "./mouse_interaction_handler.ts";
import { safeThemeBold, safeThemeFg } from "./summary_preview_renderer.ts";

const patchSlot = Symbol.for("mpep.turn-fold.patches");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;
export function applyPatches(): () => void {
	patches[patchSlot]?.();
	const disposeActivity = installActivityComponents();
	const compactionPrototype = CompactionSummaryMessageComponent.prototype as unknown as Container & {
		updateDisplay(): void;
	};
	const originalCompaction = compactionPrototype.updateDisplay;
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
					if (event?.button === "left" && event.type === "click") {
						const width = event.width || 80;
						const lines = mdComp.render ? mdComp.render(width) : [];
						const currentLine = lines[event.y] || "";
						const textWidth = visibleWidth(currentLine);
						if (event.x >= textWidth) {
							if (isCompactionDoubleClick(this, event)) {
								(this as any).setExpanded(false);
							}
							return { handled: true };
						}
						return { handled: true };
					}
					return undefined;
				});
				this.addChild(mdRegion);
			}
		};
	}
	const installedCompaction = compactionPrototype.updateDisplay;
	const dispose = () => {
		disposeActivity();
		if (compactionPrototype.updateDisplay === installedCompaction)
			compactionPrototype.updateDisplay = originalCompaction;
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
