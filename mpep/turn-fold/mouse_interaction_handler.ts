import { stripVTControlCharacters } from "node:util";
import { type Component, MouseRegion, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { toggleToolExpanded, toggleTurnExpanded } from "./turn_state_manager.ts";

interface ClickTiming {
	time: number;
	target: number | object | null;
}

const summaryClick: ClickTiming = { time: 0, target: null };
const blankClick: ClickTiming = { time: 0, target: null };
const compactionClick: ClickTiming = { time: 0, target: null };

function isDoubleClick(state: ClickTiming, target: number | object, event: TuiMouseEvent): boolean {
	if (event?.button !== "left") return false;
	if (event.clickCount && event.clickCount >= 2) return true;
	const now = Date.now();
	// Keep the fallback window independent of the terminal's native click counter.
	if (state.target === target && now - state.time < 450) {
		state.time = 0;
		state.target = null;
		return true;
	}
	state.time = now;
	state.target = target;
	return false;
}

export function isSummaryDoubleClick(event: TuiMouseEvent, turnId: number): boolean {
	return isDoubleClick(summaryClick, turnId, event);
}

export function isBlankDoubleClick(event: TuiMouseEvent, turnId: number): boolean {
	return isDoubleClick(blankClick, turnId, event);
}

export function isCompactionDoubleClick(instance: object, event: TuiMouseEvent): boolean {
	return isDoubleClick(compactionClick, instance, event);
}

/** Native Text/Markdown pad rows to the terminal width; trailing padding is still blank. */
export function isPaddedLineBlank(line: string, x: number): boolean {
	return x >= visibleWidth(stripVTControlCharacters(line).trimEnd());
}

export function resetMouseTiming(): void {
	for (const state of [summaryClick, blankClick, compactionClick]) {
		state.time = 0;
		state.target = null;
	}
}

// For the outer single-line summary bar: double-click toggles the whole turn's expand/collapse
export function createSummaryMouseRegion(component: Component, turnId: number): MouseRegion {
	return new MouseRegion(component, (event) => {
		if (event?.button === "left") {
			if (event.type === "press") {
				return { handled: true };
			}
			if (event.type === "click") {
				if (isSummaryDoubleClick(event, turnId)) {
					toggleTurnExpanded(turnId);
				}
				return { handled: true };
			}
		}
		return undefined;
	});
}

// For tool call header lines after expansion:
// - Clicking the text area: single click toggles this tool's detail expand/collapse
// - Clicking the blank area on the right: double-click collapses the whole turn
export function createToolCallMouseRegion(
	component: Component,
	toolCallId: string,
	turnId: number,
	callText: string,
	_context: { invalidate(): void },
): MouseRegion {
	return new MouseRegion(component, (event) => {
		if (event?.button === "left") {
			const textWidth = visibleWidth(callText);
			const isBlank = event.x >= textWidth;

			if (isBlank) {
				if (event.type === "press") {
					return { handled: true };
				}
				if (event.type === "click") {
					if (isBlankDoubleClick(event, turnId)) {
						toggleTurnExpanded(turnId);
					}
					return { handled: true };
				}
				return undefined;
			}

			// Hit the tool title text area: left single click toggles expand/collapse on demand
			if (event.type === "press") {
				return { handled: true };
			}
			if (event.type === "click") {
				toggleToolExpanded(toolCallId);
				return { handled: true };
			}
		}
		return undefined;
	});
}

// For the output content text area after a tool expands:
// - Never intercept press or drag, so the AltScreen terminal viewport natively supports mouse drag selection and text-selection copy;
// - Double-clicking the blank area past the end of an output line collapses the whole turn;
// - Single clicks on the text area are silently absorbed to prevent accidental collapsing.
export function createResultMouseRegion(component: Component, turnId: number): MouseRegion {
	return new MouseRegion(component, (event) => {
		if (event?.button === "left") {
			if (event.type === "click") {
				const width = event.width || 80;
				const lines = component.render(width);
				const currentLine = lines[event.y] || "";
				const textWidth = visibleWidth(currentLine);

				if (event.x >= textWidth) {
					if (isBlankDoubleClick(event, turnId)) {
						toggleTurnExpanded(turnId);
					}
					return { handled: true };
				}
				return { handled: true };
			}
		}
		return undefined;
	});
}
