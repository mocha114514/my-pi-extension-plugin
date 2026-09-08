import { parseSkillBlock, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type UserMessage = Extract<SessionMessageEntry["message"], { role: "user" }>;
export type AssistantMessage = Extract<SessionMessageEntry["message"], { role: "assistant" }>;
type UserEntry = SessionMessageEntry & { message: UserMessage };
type AssistantEntry = SessionMessageEntry & { message: AssistantMessage };

export interface CookedTurn {
	user: UserEntry;
	assistant?: AssistantEntry;
}

/** Derive rounds from the active branch, without storing another history or duration cache. */
export function collectTurns(entries: readonly SessionEntry[]): CookedTurn[] {
	const turns: CookedTurn[] = [];
	let current: CookedTurn | undefined;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") {
			current = { user: entry as UserEntry };
			turns.push(current);
		} else if (entry.message.role === "assistant" && current) {
			// Only the last assistant before the next user can be this round's final reply.
			current.assistant = entry as AssistantEntry;
		}
	}
	return turns;
}

export function elapsedForTurn(turn: CookedTurn | undefined): number | undefined {
	const assistant = turn?.assistant;
	if (!turn || !assistant) return undefined;
	if (
		assistant.message.stopReason === "pending" ||
		assistant.message.stopReason === "toolUse" ||
		assistant.message.content.some((block) => block.type === "toolCall")
	) return undefined;
	// Outer entry timestamps are written at message_end. Inner message timestamps can
	// mark request creation/queueing and would omit generation or include queue wait.
	const elapsed = Date.parse(assistant.timestamp) - Date.parse(turn.user.timestamp);
	return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

/** Match the text Pi passes to UserMessageComponent, including expanded skill prompts. */
export function userText(message: UserMessage): string {
	const text = typeof message.content === "string"
		? message.content
		: message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
	const skill = parseSkillBlock(text);
	return skill ? skill.userMessage ?? "" : text;
}

export interface TurnAnchor {
	turn: CookedTurn;
	top: number;
	bottom: number;
}

export function nearestTurn(anchors: readonly TurnAnchor[], center: number): CookedTurn | undefined {
	let nearest: CookedTurn | undefined;
	let distance = Number.POSITIVE_INFINITY;
	for (const anchor of anchors) {
		// Distance to the text area, not its midpoint: a long visible reply remains selected.
		const next = Math.max(anchor.top - center, center - anchor.bottom, 0);
		// Anchors are in document order; exact ties prefer the following round.
		if (next <= distance) {
			distance = next;
			nearest = anchor.turn;
		}
	}
	return nearest;
}

/** Seconds carry into minutes, hours and days; keep all lower units visible. */
export function formatElapsed(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}
