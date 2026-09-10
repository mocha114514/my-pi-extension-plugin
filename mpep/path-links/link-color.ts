// Keep markdown link chips in theme.link color.
// Pi paints defaultTextStyle onto link inner tokens first; that inner `\x1b[39m`
// wins over the outer theme.link wrap, so user-message chips fall back to
// userMessageText after send. Re-render link inners without the default fg.

import { getCapabilities, hyperlink, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

const patchSlot = Symbol.for("mpep.path-links.link-color");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

interface LinkToken {
	type?: string;
	href?: string;
	text?: string;
	tokens?: unknown[];
}

interface MarkdownInternals {
	theme: MarkdownTheme;
	getDefaultStylePrefix(): string;
	renderInlineTokens(tokens: unknown[] | undefined, styleContext?: InlineStyleContext): string;
}

const NEUTRAL_STYLE: InlineStyleContext = {
	applyText: (text) => text,
	stylePrefix: "",
};

function paintLink(
	markdown: MarkdownInternals,
	render: MarkdownInternals["renderInlineTokens"],
	token: LinkToken,
): string {
	const inner = render.call(markdown, token.tokens ?? [], NEUTRAL_STYLE);
	const styled = markdown.theme.link(markdown.theme.underline(inner));
	if (getCapabilities().hyperlinks) return hyperlink(styled, token.href ?? "");
	const href = token.href ?? "";
	const hrefForComparison = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
	if (token.text === href || token.text === hrefForComparison) return styled;
	return styled + markdown.theme.linkUrl(` (${href})`);
}

function stylePrefixOf(markdown: MarkdownInternals, styleContext?: InlineStyleContext): string {
	return styleContext?.stylePrefix ?? markdown.getDefaultStylePrefix?.() ?? "";
}

/** Re-paint markdown links so mdLink is the innermost (winning) foreground. */
export function installMarkdownLinkColor(): () => void {
	patches[patchSlot]?.();
	const proto = Markdown.prototype as unknown as MarkdownInternals;
	const original = proto.renderInlineTokens;

	function installed(this: MarkdownInternals, tokens: unknown[] | undefined, styleContext?: InlineStyleContext): string {
		if (!tokens?.some((token) => (token as LinkToken)?.type === "link")) {
			return original.call(this, tokens, styleContext);
		}
		let out = "";
		let run: unknown[] = [];
		const flush = (): void => {
			if (run.length === 0) return;
			out += original.call(this, run, styleContext);
			run = [];
		};
		for (const token of tokens) {
			if ((token as LinkToken)?.type !== "link") {
				run.push(token);
				continue;
			}
			flush();
			out += paintLink(this, original, token as LinkToken) + stylePrefixOf(this, styleContext);
		}
		flush();
		return out;
	}

	proto.renderInlineTokens = installed;

	const dispose = () => {
		if (proto.renderInlineTokens === installed) proto.renderInlineTokens = original;
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
