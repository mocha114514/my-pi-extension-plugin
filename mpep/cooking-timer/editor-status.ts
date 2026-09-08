import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { type Component, Container, ScrollView, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

interface BorderStatus {
	renderInBorder(width: number): string;
	renderSpinnerInBorder(width: number): string;
}
interface EditorInternals {
	workingStatusIndicator?: BorderStatus;
	renderTopBorder(width: number, hiddenLineCount: number): string;
}

/** Reuse an embedded working indicator's location without replacing the editor factory. */
export function createEditorStatus(tui: TUI, label: () => string): { sync(): boolean; dispose(): void } {
	let current: CustomEditor | undefined;
	let restore: (() => void) | undefined;
	let disposed = false;
	const find = (components: readonly Component[]): CustomEditor | undefined => {
		// The input dock is after the transcript. Search from the end and skip scrollback.
		for (let index = components.length - 1; index >= 0; index--) {
			const component = components[index];
			if (component instanceof CustomEditor) return component;
			if (component instanceof Container && !(component instanceof ScrollView)) {
				const editor = find(component.children);
				if (editor) return editor;
			}
		}
		return undefined;
	};
	return {
		sync() {
			if (disposed) return false;
			const found = find(tui.children ?? []);
			const editor = found?.embedWorkingStatus ? found : undefined;
			if (editor === current) return editor !== undefined;
			restore?.();
			restore = undefined;
			current = editor;
			if (!editor) return false;
			// Pi has no idle-border API. Wrap only this editor instance, preserving the
			// native layout/overflow rules and the MPEP editor's own confirmation border.
			const internals = editor as unknown as EditorInternals;
			const original = internals.renderTopBorder;
			const descriptor = Object.getOwnPropertyDescriptor(editor, "renderTopBorder");
			const status: BorderStatus = {
				renderInBorder: (width) => truncateToWidth(label(), width, ""),
				renderSpinnerInBorder: () => "",
			};
			const render = function (this: EditorInternals, width: number, hidden: number): string {
				if (disposed || this.workingStatusIndicator || !label()) return original.call(this, width, hidden);
				// Install only for this synchronous render. Never retain/replace a native
				// working, retry, compaction or summary indicator between calls.
				this.workingStatusIndicator = status;
				try { return original.call(this, width, hidden); }
				finally { if (this.workingStatusIndicator === status) this.workingStatusIndicator = undefined; }
			};
			internals.renderTopBorder = render;
			restore = () => {
				if (internals.renderTopBorder !== render) return;
				if (descriptor) Object.defineProperty(editor, "renderTopBorder", descriptor);
				else Reflect.deleteProperty(editor, "renderTopBorder");
			};
			return true;
		},
		dispose() {
			disposed = true;
			restore?.();
			restore = undefined;
			current = undefined;
		},
	};
}
