import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { setupMarkdownEnhancements } from "./markdown_rendering_enhancer.ts";

// Standalone plugin: terminal Markdown rendering enhancements
// (rounded code blocks, typographic list bullets, bold emphasis lift,
// callout/heading/inline-symbol transformers). Extracted from
// turn-fold (formerly stylized-design) so users can toggle it independently; prototype
// patches are global, so every Markdown component (including those
// rendered by other plugins) benefits while this plugin is enabled.
export default function markdownEnhancer(pi: ExtensionAPI): void {
	if (!isPluginEnabled("markdown-enhancer")) return;
	const disposeMarkdown = setupMarkdownEnhancements(pi);
	pi.on("session_shutdown", () => disposeMarkdown());
}
