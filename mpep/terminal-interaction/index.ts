import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { setupEditorEnhancements } from "./terminal_editor_enhancer.ts";

// Standalone plugin: terminal input-editor interaction enhancements
// (selection copy/cut, Ctrl+C double-confirm exit guard, cross-platform undo,
// hardware bar cursor). Extracted from stylized-design so users can toggle it
// independently of the visual layout plugin.
export default function terminalInteraction(pi: ExtensionAPI): void {
	if (!isPluginEnabled("terminal-interaction")) return;
	const disposeEditor = setupEditorEnhancements(pi);
	pi.on("session_shutdown", () => disposeEditor());
}
