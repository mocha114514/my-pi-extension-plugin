import { t } from "../shared/i18n/index.ts";
import { stripVTControlCharacters } from "node:util";
import { type Component, MouseRegion, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { toggleCookingProcess } from "./cooking_process_state.ts";
import type { CookingProcessState } from "./extension_types.ts";
import { getLatestTheme } from "./summary_preview_renderer.ts";

// Process identity survives component rebuilds; header and blank-area clicks stay independent.
const clicks = new WeakMap<CookingProcessState, { header?: number; blank?: number }>();

function doubleClick(process: CookingProcessState, event: TuiMouseEvent, area: "header" | "blank"): boolean {
	const timing = clicks.get(process) ?? {};
	const now = Date.now();
	const previous = timing[area];
	const twice = (event.clickCount ?? 0) >= 2 || (previous !== undefined && now - previous < 450);
	timing[area] = twice ? undefined : now;
	clicks.set(process, timing);
	return twice;
}

export function createCookingHeader(process: CookingProcessState): Component {
	return new MouseRegion(
		{
			render(width) {
				const theme = getLatestTheme();
				const label = `${process.expanded ? "\u25bc" : "\u25b6"} ${t("activity.cookingProcess")}`;
				return [truncateToWidth(theme.fg("toolTitle", theme.bold(label)), Math.max(1, width), "")];
			},
			invalidate() {},
		},
		(event) => {
			if (event.button !== "left") return;
			if (event.type === "press") return { handled: true };
			if (event.type === "click") {
				if (doubleClick(process, event, "header")) toggleCookingProcess(process);
				return { handled: true };
			}
		},
	);
}

export function createCookingBody(component: Component, process: CookingProcessState): Component {
	return new MouseRegion(component, (event) => {
		if (!process.expanded || event.button !== "left") return;
		const line = component.render(event.width)[event.y] ?? "";
		// Native Markdown pads rows to the terminal width; padding is still clickable whitespace.
		if (event.x < visibleWidth(stripVTControlCharacters(line).trimEnd())) return;
		if (event.type === "press") return { handled: true };
		if (event.type === "click") {
			if (doubleClick(process, event, "blank")) toggleCookingProcess(process);
			return { handled: true };
		}
	});
}

export function createCookingSeparator(): Component {
	return {
		render(width) {
			return [getLatestTheme().fg("muted", "\u2500".repeat(Math.max(0, width)))];
		},
		invalidate() {},
	};
}
