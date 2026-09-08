// Standalone Markdown rendering enhancer, originally part of stylized-design.
// Self-contained: only depends on Pi's public extension API and pi-tui, so it
// can be toggled independently via the markdown-enhancer plugin entry.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const patchSlot = Symbol.for("mpep.markdown-enhancer.markdown-patches");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

/**
 * Bullet hierarchy for nested unordered lists.
 */
const UNORDERED_BULLETS = ["• ", "◦ ", "▪ "];

/**
 * Base left margin (indent) for the first level of lists.
 */
const BASE_INDENT = "  ";

/**
 * Patch Markdown.prototype.renderToken at runtime to enhance code blocks
 * with stylish full rounded borders, skipping mermaid diagrams.
 */
function applyCodeBlockPatch(): () => void {
	const proto = Markdown.prototype as any;
	let active = true;

	const originalRenderToken = proto.renderToken;

	proto.renderToken = function (token: any, width: number, nextTokenType?: string, styleContext?: any): string[] {
		if (active && token?.type === "code") {
			const lang = (token.lang || "").trim().split(/\s+/, 1)[0].toLowerCase();
			// Skip mermaid diagrams: Pi natively captures and renders them
			if (lang === "mermaid") {
				return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
			}

			try {
				if (width < 10) {
					return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
				}

				const lines: string[] = [];
				const border = (text: string) => (this.theme.codeBlockBorder ? this.theme.codeBlockBorder(text) : text);
				const innerWidth = Math.max(1, width - 4);
				const displayLang = token.lang?.trim() ? ` ${token.lang.trim()} ` : "";
				const langWidth = visibleWidth(displayLang);
				const minHeaderWidth = 3 + langWidth;

				let topHeader: string;
				if (langWidth > 0 && width >= minHeaderWidth) {
					const fill = width - minHeaderWidth;
					const styledLang = this.theme.bold ? border(this.theme.bold(displayLang)) : border(displayLang);
					topHeader = border("╭─") + styledLang + border("─".repeat(fill) + "╮");
				} else {
					topHeader = border("╭" + "─".repeat(Math.max(0, width - 2)) + "╮");
				}
				lines.push(topHeader);

				const rawText = token.text ?? "";
				const highlightedLines: string[] = this.theme.highlightCode
					? this.theme.highlightCode(rawText, token.lang)
					: rawText
							.split("\n")
							.map((line: string) => (this.theme.codeBlock ? this.theme.codeBlock(line) : line));

				for (const hlLine of highlightedLines) {
					const wrapped = wrapTextWithAnsi(hlLine, innerWidth);
					if (wrapped.length === 0) {
						lines.push(border("│ ") + " ".repeat(innerWidth) + border(" │"));
					} else {
						for (const subLine of wrapped) {
							const padLen = Math.max(0, innerWidth - visibleWidth(subLine));
							lines.push(border("│ ") + subLine + " ".repeat(padLen) + border(" │"));
						}
					}
				}

				lines.push(border("╰" + "─".repeat(Math.max(0, width - 2)) + "╯"));

				if (nextTokenType && nextTokenType !== "space") {
					lines.push("");
				}

				return lines;
			} catch {
				return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
			}
		}

		return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
	};
	const installed = proto.renderToken;
	return () => {
		active = false;
		if (proto.renderToken === installed) proto.renderToken = originalRenderToken;
	};
}

/**
 * Patch Markdown.prototype.renderList at runtime to enhance unordered lists
 * with typographic bullet icons (•, ◦, ▪), base indentation, and proper wrapping.
 */
function applyListPatch(): () => void {
	const proto = Markdown.prototype as any;
	let active = true;

	const originalRenderList = proto.renderList;

	proto.renderList = function (token: any, depth: number, width: number, styleContext?: any): string[] {
		if (!active) return originalRenderList.call(this, token, depth, width, styleContext);
		try {
			const lines: string[] = [];
			const indent = BASE_INDENT + "    ".repeat(depth);
			const startNumber = typeof token.start === "number" ? token.start : 1;

			for (let i = 0; i < token.items.length; i++) {
				const item = token.items[i];
				const isLastItem = i === token.items.length - 1;

				let bullet: string;
				if (token.ordered) {
					bullet = this.options?.preserveOrderedListMarkers
						? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
						: `${startNumber + i}. `;
				} else if (item.task) {
					bullet = "";
				} else {
					bullet = UNORDERED_BULLETS[Math.min(depth, UNORDERED_BULLETS.length - 1)];
				}

				const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
				const marker = bullet + taskMarker;
				const firstPrefix = indent + this.theme.listBullet(marker);
				const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
				const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
				let renderedAnyLine = false;

				for (const itemToken of item.tokens) {
					if (itemToken.type === "list") {
						lines.push(...this.renderList(itemToken, depth + 1, width, styleContext));
						renderedAnyLine = true;
						continue;
					}

					const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
					for (const line of itemLines) {
						for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
							const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
							lines.push(linePrefix + wrappedLine);
							renderedAnyLine = true;
						}
					}
				}

				if (!renderedAnyLine) {
					lines.push(firstPrefix);
				}

				if (token.loose && !isLastItem) {
					lines.push("");
				}
			}

			return lines;
		} catch {
			return originalRenderList.call(this, token, depth, width, styleContext);
		}
	};
	const installed = proto.renderList;
	return () => {
		active = false;
		if (proto.renderList === installed) proto.renderList = originalRenderList;
	};
}

/**
 * Patch Markdown.prototype to enhance bold rendering with visual emphasis,
 * ensuring bold text is clearly distinguishable in terminal environments
 * regardless of terminal font fallback or weight limitations.
 */
function applyBoldPatch(): () => void {
	const proto = Markdown.prototype as any;
	let active = true;
	const themes = new WeakMap<MarkdownTheme, { original: MarkdownTheme["bold"]; installed: MarkdownTheme["bold"] }>();
	const themeRefs = new Set<WeakRef<MarkdownTheme>>();
	const enhanceThemeBold = (theme: MarkdownTheme) => {
		if (active && theme && !themes.has(theme)) {
			const original = theme.bold;
			const origBold = original ? original.bind(theme) : (s: string) => `\x1b[1m${s}\x1b[22m`;
			const installed = (text: string) => {
				if (!active) return origBold(text);
				const styled = text.includes("\x1b[39m") ? text.replaceAll("\x1b[39m", "\x1b[39m\x1b[97m") : text;
				return origBold(`\x1b[97m${styled}\x1b[39m`);
			};
			themes.set(theme, { original, installed });
			// Retain rollback information without keeping discarded message themes alive.
			themeRefs.add(new WeakRef(theme));
			theme.bold = installed;
		}
	};

	const originalRender = proto.render;
	proto.render = function (width: number): string[] {
		enhanceThemeBold(this.theme);
		return originalRender.call(this, width);
	};

	const originalRenderToken = proto.renderToken;
	proto.renderToken = function (token: any, width: number, nextTokenType?: string, styleContext?: any): string[] {
		enhanceThemeBold(this.theme);
		return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
	};
	const installedRender = proto.render;
	const installedRenderToken = proto.renderToken;
	return () => {
		active = false;
		if (proto.render === installedRender) proto.render = originalRender;
		if (proto.renderToken === installedRenderToken) proto.renderToken = originalRenderToken;
		for (const reference of themeRefs) {
			const theme = reference.deref();
			if (!theme) continue;
			const patch = themes.get(theme);
			if (patch && theme.bold === patch.installed) theme.bold = patch.original;
			themes.delete(theme);
		}
		themeRefs.clear();
	};
}

/**
 * Replace ASCII symbols with typographic Unicode characters,
 * strictly skipping inline code blocks wrapped in backticks.
 */
function enhanceInlineSymbols(text: string): string {
	const segments = text.split(/(`[^`]*`)/g);

	for (let i = 0; i < segments.length; i += 2) {
		let seg = segments[i];
		seg = seg.replaceAll("<=>", "⇔");
		seg = seg.replaceAll("==>", "⇒");
		seg = seg.replaceAll("-->", "→");
		seg = seg.replaceAll("->", "→");
		seg = seg.replaceAll("=>", "⇒");
		seg = seg.replaceAll("<-", "←");
		seg = seg.replaceAll("<=", "≤");
		seg = seg.replaceAll(">=", "≥");
		seg = seg.replaceAll("!=", "≠");
		segments[i] = seg;
	}

	return segments.join("");
}

/**
 * Transform GitHub-style admonition callouts to clean badges.
 */
function enhanceCallouts(line: string): string {
	return line
		.replace(/^(\s*>\s*)\[!NOTE\]/i, "$1**[Note]**")
		.replace(/^(\s*>\s*)\[!TIP\]/i, "$1**[Tip]**")
		.replace(/^(\s*>\s*)\[!IMPORTANT\]/i, "$1**[Important]**")
		.replace(/^(\s*>\s*)\[!WARNING\]/i, "$1**[Warning]**")
		.replace(/^(\s*>\s*)\[!CAUTION\]/i, "$1**[Caution]**");
}

/**
 * Transform headings level 3 and below to eliminate raw '#' in terminal
 * while leveraging Pi's native H2 styling (which strips the '##' marker).
 */
function enhanceHeadings(line: string): string {
	if (/^(\s*)###\s+(.*)$/.test(line)) {
		return line.replace(/^(\s*)###\s+(.*)$/, "$1## ◈ $2");
	}
	if (/^(\s*)####\s+(.*)$/.test(line)) {
		return line.replace(/^(\s*)####\s+(.*)$/, "$1## ▸ $2");
	}
	if (/^(\s*)#{5,}\s+(.*)$/.test(line)) {
		return line.replace(/^(\s*)#{5,}\s+(.*)$/, "$1## ▹ $2");
	}
	return line;
}

/**
 * Bracket and quotation pairs to lift outside bold markers when wrapping bold text,
 * ensuring CommonMark delimiter flanking rules are satisfied in CJK contexts.
 */
const BOLD_BRACKET_PAIRS: [string, string][] = [
	["“", "”"],
	["‘", "’"],
	["《", "》"],
	["（", "）"],
	["【", "】"],
	["「", "」"],
	["『", "』"],
	["〈", "〉"],
	["(", ")"],
	["[", "]"],
	['"', '"'],
	["'", "'"],
];
const BOLD_BRACKET_PATTERNS = BOLD_BRACKET_PAIRS.map(([open, close]) => {
	const escOpen = open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const escClose = close.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return { open, close, pattern: new RegExp(`\\*\\*${escOpen}([\\s\\S]*?)${escClose}\\*\\*`, "g") };
});

/**
 * Clean up accidental spaces inside bold markers (e.g. `** text **` -> `**text**`),
 * strictly preserving inline code spans wrapped in backticks.
 */
function enhanceBoldSyntax(text: string): string {
	if (!text.includes("**")) return text;
	const segments = text.split(/(`[^`]*`)/g);

	for (let i = 0; i < segments.length; i += 2) {
		let seg = segments[i];

		// 1. Clean up accidental spaces inside bold markers: ** text ** -> **text**
		seg = seg.replace(/\*\*\s*([^\*\n]+?)\s*\*\*/g, (match, p1) => {
			return p1.trim() ? `**${p1.trim()}**` : match;
		});

		// 2. Lift matching outer quotation marks or brackets: **“text”** -> “**text**”
		for (const { open, close, pattern } of BOLD_BRACKET_PATTERNS) {
			seg = seg.replace(pattern, (_match, inner) => {
				return `${open}**${inner.trim()}**${close}`;
			});
		}

		// 3. Fix boundary conflicts where bold isn't bracket-wrapped:
		// If opening ** is preceded by non-space/non-punct (e.g. Hanzi) and inner starts with punct,
		// or closing ** is followed by non-space/non-punct and inner ends with punct,
		// insert boundary spaces so CommonMark satisfies left/right flanking rules.
		let result = "";
		let lastIndex = 0;
		const boldRegex = /\*\*([^\*\n]+?)\*\*/g;
		let match: RegExpExecArray | null;

		while ((match = boldRegex.exec(seg)) !== null) {
			const matchStart = match.index;
			const matchEnd = boldRegex.lastIndex;
			const inner = match[1];

			const preChar = matchStart > 0 ? seg[matchStart - 1] : "";
			const postChar = matchEnd < seg.length ? seg[matchEnd] : "";

			let prefix = "";
			let suffix = "";

			if (preChar && /[^\s\p{P}]/u.test(preChar) && /^\p{P}/u.test(inner)) {
				prefix = " ";
			}

			if (postChar && /[^\s\p{P}]/u.test(postChar) && /\p{P}$/u.test(inner)) {
				suffix = " ";
			}

			result += seg.slice(lastIndex, matchStart) + prefix + `**${inner}**` + suffix;
			lastIndex = matchEnd;
		}
		result += seg.slice(lastIndex);
		seg = result;

		segments[i] = seg;
	}

	return segments.join("");
}

/**
 * Setup Markdown enhancements:
 * - Prototype patches on Markdown component (lists, code blocks, bold text)
 * - Markdown transformer registration (callouts, headings, bold syntax, inline symbols)
 */
export function setupMarkdownEnhancements(pi: ExtensionAPI): () => void {
	patches[patchSlot]?.();
	const disposeList = applyListPatch();
	const disposeCodeBlock = applyCodeBlockPatch();
	const disposeBold = applyBoldPatch();
	let active = true;
	const dispose = () => {
		if (!active) return;
		active = false;
		// Bold wraps renderToken after the code block patch, so unwind in reverse order.
		disposeBold();
		disposeCodeBlock();
		disposeList();
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;

	pi.registerMarkdownTransformer((markdown, context) => {
		// Only transform assistant and user messages (avoid interfering with internal thinking blocks)
		if (!active || context.messageType === "assistant-thinking") {
			return markdown;
		}

		const lines = markdown.split("\n");
		const transformed: string[] = [];

		let inCodeBlock = false;
		let codeBlockChar = "";

		for (const line of lines) {
			const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
			if (fenceMatch) {
				const char = fenceMatch[2][0];
				if (!inCodeBlock) {
					inCodeBlock = true;
					codeBlockChar = char;
				} else if (char === codeBlockChar) {
					inCodeBlock = false;
					codeBlockChar = "";
				}
				transformed.push(line);
				continue;
			}

			if (inCodeBlock) {
				// Keep code block content 100% intact
				transformed.push(line);
				continue;
			}

			// 1. Transform callouts
			let processed = enhanceCallouts(line);

			// 2. Transform headings to avoid raw '#' display
			processed = enhanceHeadings(processed);

			// 3. Clean up loose spaces in bold markers outside inline code
			processed = enhanceBoldSyntax(processed);

			// 4. Enhance typographic symbols outside inline code
			processed = enhanceInlineSymbols(processed);

			transformed.push(processed);
		}

		return transformed.join("\n");
	});
	return dispose;
}
