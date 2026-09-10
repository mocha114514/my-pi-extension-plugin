import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { isPluginEnabled } from "../manager/preferences.ts";
import { patchSelectionCopy } from "./copy.ts";
import { installEditorPathChips } from "./editor.ts";
import { enablePathLinkHyperlinks } from "./hyperlinks.ts";
import { installPathLinkInteraction } from "./interaction.ts";
import { installMarkdownLinkColor } from "./link-color.ts";
import { transformPathMarkdown } from "./paths.ts";

const PLUGIN_ID = "path-links";
const BRIDGE = "path-links-bridge";
const SLOT = Symbol.for("mpep.path-links.dispose");
const installations = globalThis as unknown as Record<symbol, (() => void) | undefined>;

export default function pathLinks(pi: ExtensionAPI): void {
	if (!isPluginEnabled(PLUGIN_ID)) return;

	installations[SLOT]?.();
	enablePathLinkHyperlinks();
	let theme: () => Pick<Theme, "fg"> = () => ({ fg: (_key, text) => text });
	const disposeCopy = patchSelectionCopy();
	const disposeEditor = installEditorPathChips(() => theme());
	const disposeLinkColor = installMarkdownLinkColor();
	let interaction: ReturnType<typeof installPathLinkInteraction> | undefined;

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType === "assistant-thinking") return markdown;
		if (!getCapabilities().hyperlinks) return markdown;
		return transformPathMarkdown(markdown);
	});

	const dispose = () => {
		interaction?.dispose();
		interaction = undefined;
		disposeEditor();
		disposeCopy();
		disposeLinkColor();
		if (installations[SLOT] === dispose) delete installations[SLOT];
	};
	installations[SLOT] = dispose;

	pi.on("session_start", (_event, ctx) => {
		interaction?.dispose();
		interaction = undefined;
		enablePathLinkHyperlinks();
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		theme = () => ctx.ui.theme;
		interaction = installPathLinkInteraction({ theme: () => ctx.ui.theme });
		ctx.ui.setWidget(BRIDGE, (tui) => {
			interaction?.attach(tui);
			return { render: () => [], invalidate() {} };
		});
		ctx.ui.setWidget(BRIDGE, undefined);
	});
	pi.on("session_shutdown", dispose);
}
