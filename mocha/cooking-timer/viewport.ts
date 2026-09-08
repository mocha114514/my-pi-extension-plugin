import {
	AssistantMessageComponent,
	type SessionEntry,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, type ScrollView, type TUI } from "@earendil-works/pi-tui";
import { type AssistantMessage, type CookedTurn, elapsedForTurn, nearestTurn, type TurnAnchor, userText } from "./history.ts";

interface Rect { x: number; y: number; width: number; height: number }
interface LayoutBox {
	component: Component;
	rect: Rect;
	clip: Rect;
	children: LayoutBox[];
	scrollContentLines?: readonly string[];
}
interface RenderedChild { component: Component; height: number }
type RenderedMessage = { top: number; bottom: number } & (
	| { role: "user"; text: string }
	| { role: "assistant"; message: AssistantMessage }
);

// Pi 0.85.x exposes no transcript-geometry extension API. Confine the read-only
// internal access to this module, and use only the host's completed render caches.
function readViewport(reference: TUI): { center: number; messages: RenderedMessage[] } | undefined {
	const tui = reference.valueOf() as TUI & {
		currentLayout?: { root: LayoutBox; primaryScrollView?: ScrollView };
	};
	if (tui.mode !== "fullscreen") return undefined;
	const layout = tui.currentLayout;
	const scroll = layout?.primaryScrollView;
	if (!layout || !scroll) return undefined;
	const find = (box: LayoutBox): LayoutBox | undefined => {
		if (box.component === scroll) return box;
		for (const child of box.children) {
			const found = find(child);
			if (found) return found;
		}
		return undefined;
	};
	const box = find(layout.root);
	if (!box || box.clip.height <= 0) return undefined;
	const width = scroll.getContentWidth(box.rect.width);
	const messages: RenderedMessage[] = [];
	const visit = (component: Component, row: number, height: number): boolean => {
		if (height <= 0) return true;
		if (component instanceof UserMessageComponent) {
			const text = (component as unknown as { text?: string }).text;
			if (typeof text !== "string") return false;
			messages.push({ role: "user", text, top: row + Math.min(1, height - 1), bottom: row + Math.max(0, height - 2) });
			return true;
		}
		if (component instanceof AssistantMessageComponent) {
			const message = (component as unknown as { lastMessage?: AssistantMessage }).lastMessage;
			if (message) messages.push({ role: "assistant", message, top: row + Math.min(1, height - 1), bottom: row + height - 1 });
			return true;
		}
		// Tools, custom renderers and summaries have their own offsets. Do not infer
		// message identities from their text or from OSC markers shared by both roles.
		if (!(component instanceof Container) || component.render !== Container.prototype.render) return true;
		const cached = (component as unknown as { mouseLayout?: { width: number; children: RenderedChild[] } }).mouseLayout;
		if (
			cached?.width !== width || cached.children.length !== component.children.length ||
			cached.children.some((child, index) => child.component !== component.children[index]) ||
			cached.children.reduce((sum, child) => sum + child.height, 0) !== height
		) return false;
		let offset = row;
		for (const child of cached.children) {
			if (!visit(child.component, offset, child.height)) return false;
			offset += child.height;
		}
		return true;
	};
	const document = scroll.children[0];
	const valid = document && visit(document, 0, box.scrollContentLines?.length ?? 0);
	return {
		center: scroll.scrollTop + box.clip.y - box.rect.y + (box.clip.height - 1) / 2,
		messages: valid ? messages : [],
	};
}

export function selectViewportTurn(reference: TUI, entries: readonly SessionEntry[], turns: readonly CookedTurn[]): CookedTurn | undefined {
	const viewport = readViewport(reference);
	// Regular terminals own their scrollback; Pi has no coordinates for that scroll position.
	if (!viewport) return turns.findLast((turn) => elapsedForTurn(turn) !== undefined);
	const records = entries.filter((entry) => entry.type === "message");
	const positions = new Map(records.map((entry, index) => [entry.message, index]));
	const users = new Map(turns.map((turn) => [turn.user.message, turn]));
	const assistants = new Map(turns.filter((turn) => turn.assistant).map((turn) => [turn.assistant!.message, turn]));
	const anchors: TurnAnchor[] = [];
	let before = records.length;
	// Match backwards, constrained by actual assistant object identities. This keeps
	// repeated user prompts aligned after compaction, forks and partial transcript rebuilds.
	for (let index = viewport.messages.length - 1; index >= 0; index--) {
		const rendered = viewport.messages[index];
		let turn: CookedTurn | undefined;
		if (rendered.role === "assistant") {
			const position = positions.get(rendered.message);
			if (position === undefined || position >= before) continue;
			before = position;
			const candidate = assistants.get(rendered.message);
			if (elapsedForTurn(candidate) !== undefined) turn = candidate;
		} else {
			for (let position = before - 1; position >= 0; position--) {
				const message = records[position].message;
				if (message.role !== "user" || userText(message) !== rendered.text) continue;
				before = position;
				turn = users.get(message);
				break;
			}
		}
		if (turn) anchors.push({ turn, top: rendered.top, bottom: rendered.bottom });
	}
	return nearestTurn(anchors.reverse(), viewport.center);
}
