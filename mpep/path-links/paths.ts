// Path detection, markdown rewriting, and OSC 8 copy expansion for path-links.
// Comments in English per repo convention.

export const PATH_HREF_PREFIX = "mpep-path:";

export interface PathHit {
	start: number;
	end: number;
	path: string;
	complete: boolean;
}

const TRAILING_PUNCT = /[.,;:!?)\]]+$/;
const SCHEME_AT_START = /^[a-zA-Z][a-zA-Z+.-]*:/;
const WINDOWS_ABS = /(?<![A-Za-z0-9_])([A-Za-z]:[\\/][^\s`|*?"<>\]]*)/g;
const UNC_ABS = /(\\\\[^\s`|*?"<>\]]+)/g;
const HOME_ABS = /(~[\\/][^\s`|*?"<>\]]+)/g;
const UNIX_ABS = /(?<![A-Za-z0-9_:])(\/(?:[^\s`|*?"<>\]]+\/)+[^\s`|*?"<>\]]+)/g;
const RELATIVE_FILE = /(?<![A-Za-z0-9_./-])((?:\.?[A-Za-z0-9_-]+[\\/]){2,}[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?![A-Za-z0-9_.-])/g;
const QUOTED = /(?<![A-Za-z0-9_])(["'])((?:\\.|(?!\1).)+)\1/g;
const URL_SPAN = /\b(?:(?:https?|mailto|file|ftp):|www\.)[^\s)\]]+/gi;
const INLINE_CODE = /(`+)((?:(?!\1).|\\.)*)\1/g;
const MD_LINK = /!?\[(?:[^\[\]\\]|\\.)*\]\((?:<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;

export function encodePathHref(path: string): string {
	return `${PATH_HREF_PREFIX}${encodeURIComponent(path)}`;
}

export function decodePathHref(href: string | undefined): string | undefined {
	if (!href?.startsWith(PATH_HREF_PREFIX)) return undefined;
	try {
		return decodeURIComponent(href.slice(PATH_HREF_PREFIX.length));
	} catch {
		return href.slice(PATH_HREF_PREFIX.length);
	}
}

export function isCompletePath(path: string): boolean {
	return (
		/^[A-Za-z]:[\\/]/.test(path) ||
		path.startsWith("\\\\") ||
		path.startsWith("~/") ||
		path.startsWith("~\\") ||
		(path.startsWith("/") && !path.startsWith("//"))
	);
}

export function displayName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]/);
	const last = parts.at(-1);
	return last && last.length > 0 ? last : path;
}

export function toMarkdownLink(path: string): string {
	const name = displayName(path).replace(/[\[\]]/g, "");
	return `[${name || path}](${encodePathHref(path)})`;
}

function trimPathCandidate(raw: string): string {
	let path = raw;
	while (path.length > 3 && TRAILING_PUNCT.test(path) && !/[\\/]$/.test(path)) {
		path = path.replace(TRAILING_PUNCT, "");
	}
	return path;
}

function overlaps(start: number, end: number, ranges: Array<{ start: number; end: number }>): boolean {
	return ranges.some((range) => start < range.end && end > range.start);
}

function allMatches(text: string, regex: RegExp): RegExpMatchArray[] {
	return [...text.matchAll(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`))];
}

function collectMatches(text: string, regex: RegExp, group: number): PathHit[] {
	const hits: PathHit[] = [];
	for (const match of allMatches(text, regex)) {
		const captured = match[group] ?? match[0];
		const path = trimPathCandidate(captured);
		if (!path || (SCHEME_AT_START.test(path) && !/^[A-Za-z]:[\\/]/.test(path))) continue;
		const offset = match[0].indexOf(captured);
		const start = (match.index ?? 0) + Math.max(0, offset);
		const end = start + captured.length - (captured.length - path.length);
		if (end <= start) continue;
		hits.push({ start, end, path, complete: isCompletePath(path) });
	}
	return hits;
}

function unquotedHits(text: string): PathHit[] {
	return [
		...collectMatches(text, WINDOWS_ABS, 1),
		...collectMatches(text, UNC_ABS, 1),
		...collectMatches(text, HOME_ABS, 1),
		...collectMatches(text, UNIX_ABS, 1),
		...collectMatches(text, RELATIVE_FILE, 1),
	];
}

function classifyQuotedInner(inner: string): { path: string; complete: boolean } | undefined {
	const hits = unquotedHits(inner);
	if (hits.length === 1 && hits[0].start === 0 && hits[0].end === inner.length) return hits[0];
	if (isCompletePath(inner) && /[\\/]/.test(inner)) return { path: inner, complete: true };
	return undefined;
}

function quotedHits(text: string): PathHit[] {
	const hits: PathHit[] = [];
	for (const match of allMatches(text, QUOTED)) {
		const inner = match[2] ?? "";
		const classified = classifyQuotedInner(inner);
		if (!classified) continue;
		hits.push({
			start: match.index ?? 0,
			end: (match.index ?? 0) + match[0].length,
			path: classified.path,
			complete: classified.complete,
		});
	}
	return hits;
}

function protectedSpans(text: string): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = [];
	for (const regex of [URL_SPAN, MD_LINK]) {
		for (const match of allMatches(text, regex)) {
			spans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
		}
	}
	return spans;
}

/** Classify a whole string as a single path, or return undefined. */
export function classifyPath(text: string): PathHit | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const hits = findPathHits(trimmed);
	if (hits.length !== 1 || hits[0].start !== 0 || hits[0].end !== trimmed.length) return undefined;
	return hits[0];
}

export function findPathHits(text: string): PathHit[] {
	if (!text) return [];
	const blocked = protectedSpans(text);
	const quoted = quotedHits(text);
	const unquoted = unquotedHits(text);
	const merged: PathHit[] = [];
	const quotedSpans = quoted.map((hit) => ({ start: hit.start, end: hit.end }));
	for (const hit of [...quoted, ...unquoted].sort((a, b) => a.start - b.start || b.end - a.end)) {
		if (overlaps(hit.start, hit.end, blocked)) continue;
		if (quoted.includes(hit) === false && overlaps(hit.start, hit.end, quotedSpans)) continue;
		if (overlaps(hit.start, hit.end, merged)) continue;
		if (hit.path.length < 2) continue;
		merged.push(hit);
	}
	return merged;
}

interface Segment {
	start: number;
	end: number;
	kind: "code" | "text";
	raw: string;
}

function splitInline(line: string): Segment[] {
	const segments: Segment[] = [];
	const codes: Array<{ start: number; end: number }> = [];
	for (const match of allMatches(line, INLINE_CODE)) {
		codes.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
	}
	let cursor = 0;
	for (const code of codes) {
		if (code.start > cursor) segments.push({ start: cursor, end: code.start, kind: "text", raw: line.slice(cursor, code.start) });
		segments.push({ start: code.start, end: code.end, kind: "code", raw: line.slice(code.start, code.end) });
		cursor = code.end;
	}
	if (cursor < line.length) segments.push({ start: cursor, end: line.length, kind: "text", raw: line.slice(cursor) });
	return segments;
}

function transformLine(line: string): string {
	if (!line) return line;
	let out = "";
	for (const segment of splitInline(line)) {
		if (segment.kind === "code") {
			const fence = /^(`+)([\s\S]*)\1$/.exec(segment.raw);
			const inner = fence?.[2] ?? "";
			const hit = classifyPath(inner);
			out += hit ? toMarkdownLink(hit.path) : segment.raw;
			continue;
		}
		const hits = findPathHits(segment.raw);
		if (hits.length === 0) {
			out += segment.raw;
			continue;
		}
		let cursor = 0;
		for (const hit of hits) {
			out += segment.raw.slice(cursor, hit.start);
			out += toMarkdownLink(hit.path);
			cursor = hit.end;
		}
		out += segment.raw.slice(cursor);
	}
	return out;
}

/** Rewrite detected paths in markdown (outside fenced code) into short OSC 8 links. */
export function transformPathMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	const transformed: string[] = [];
	let inFence = false;
	let fenceChar = "";
	for (const line of lines) {
		const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
		if (fenceMatch) {
			const char = fenceMatch[2][0] ?? "";
			if (!inFence) {
				inFence = true;
				fenceChar = char;
			} else if (char === fenceChar) {
				inFence = false;
				fenceChar = "";
			}
			transformed.push(line);
			continue;
		}
		transformed.push(inFence ? line : transformLine(line));
	}
	return transformed.join("\n");
}

const OSC8 = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

function emitChunk(chunk: string, active: string | undefined, strip: (value: string) => string): string {
	const visible = strip(chunk);
	if (!visible) return "";
	return decodePathHref(active) ?? visible;
}

/** Replace visible short names of our OSC 8 links with the original path. */
export function expandPathLinks(ansi: string, strip: (value: string) => string): string {
	if (!ansi.includes("\x1b]8;")) return strip(ansi);
	let result = "";
	let active: string | undefined;
	let last = 0;
	for (const match of allMatches(ansi, OSC8)) {
		result += emitChunk(ansi.slice(last, match.index ?? 0), active, strip);
		active = match[1] ? match[1] : undefined;
		last = (match.index ?? 0) + match[0].length;
	}
	result += emitChunk(ansi.slice(last), active, strip);
	return result;
}
