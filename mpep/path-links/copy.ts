// Expand copied path-link chips back to the original filesystem path.

import { sliceByColumn, stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import { expandPathLinks } from "./paths.ts";

interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: unknown;
	boundary?: boolean;
}

interface LayoutNode {
	scrollView?: unknown;
	scrollContentLines?: readonly string[];
	children?: LayoutNode[];
}

interface SelectionInternals {
	getSelectionBounds?: () => { start: SelectionPoint; end: SelectionPoint } | undefined;
	getSelectionColumns?: (
		line: string,
		row: number,
		selection: { start: SelectionPoint; end: SelectionPoint },
	) => { start: number; end: number };
	previousScreen?: string[];
	currentLayout?: { root: LayoutNode };
}

function findScrollBox(box: LayoutNode, scrollView: unknown): LayoutNode | undefined {
	if (box.scrollView === scrollView) return box;
	for (const child of box.children ?? []) {
		const found = findScrollBox(child, scrollView);
		if (found) return found;
	}
	return undefined;
}

const patchSlot = Symbol.for("mpep.path-links.copy");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

export function patchSelectionCopy(): () => void {
	patches[patchSlot]?.();
	const proto = TuiAltScreen.prototype as unknown as {
		getActiveSelectionText?: () => string | undefined;
	};
	const original = proto.getActiveSelectionText;
	if (typeof original !== "function") return () => {};

	const installed = function (this: TuiAltScreen): string | undefined {
		const internals = this as unknown as SelectionInternals;
		const selection = internals.getSelectionBounds?.();
		if (!selection || !internals.getSelectionColumns || !internals.previousScreen) {
			return original.call(this);
		}
		let sourceLines: readonly string[] = internals.previousScreen;
		if (selection.start.scrollView && internals.currentLayout) {
			const box = findScrollBox(internals.currentLayout.root, selection.start.scrollView);
			if (box?.scrollContentLines) sourceLines = box.scrollContentLines;
		}
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = sourceLines[row] ?? "";
			const columns = internals.getSelectionColumns(line, row, selection);
			const sliced = sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true);
			lines.push(expandPathLinks(sliced, stripTerminalSequences).trimEnd());
		}
		const text = lines.join("\n");
		return text.length === 0 ? undefined : text;
	};

	proto.getActiveSelectionText = installed;
	const dispose = () => {
		if (proto.getActiveSelectionText === installed) proto.getActiveSelectionText = original;
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
