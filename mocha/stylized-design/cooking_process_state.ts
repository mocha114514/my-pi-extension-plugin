import type { CookingProcessState, MessageState } from "./extension_types.ts";

const processes = new Set<CookingProcessState>();
const pending = new Set<CookingProcessState>();
let active: CookingProcessState | undefined;

export function registerCookingMessage(message: MessageState): void {
	if (message.process) return;
	if (!active) {
		active = { messages: [], expanded: false };
		processes.add(active);
		pending.add(active);
	}
	active.messages.push(message);
	message.process = active;
}

/** A user/custom message is a visible boundary, even when queued within one agent run. */
export function separateCookingProcess(): void {
	active = undefined;
}

/** Only agent_end (or a completed history boundary) confirms which text is final. */
export function completeCookingProcesses(): void {
	active = undefined;
	for (const process of pending) {
		const last = process.messages.at(-1);
		if (!last?.finished || last.message.stopReason !== "stop") continue;
		let finalPartIndex = last.parts.length;
		while (finalPartIndex > 0 && last.parts[finalPartIndex - 1].type === "text") finalPartIndex--;
		if (finalPartIndex === last.parts.length) continue;
		const anchor = process.messages.find((message) =>
			message.id === last.id ? finalPartIndex > 0 : message.parts.length > 0,
		);
		// A direct answer with no preceding work does not need an empty disclosure.
		if (!anchor) continue;
		process.fold = { anchorMessageId: anchor.id, finalMessageId: last.id, finalPartIndex };
		process.expanded = false;
		for (const message of process.messages) message.refresh?.();
	}
	pending.clear();
}

export function toggleCookingProcess(process: CookingProcessState): void {
	if (!process.fold) return;
	process.expanded = !process.expanded;
	for (const message of process.messages) message.refresh?.();
}

export function setAllCookingExpanded(expanded: boolean): void {
	for (const process of processes) {
		if (!process.fold || process.expanded === expanded) continue;
		process.expanded = expanded;
		for (const message of process.messages) message.refresh?.();
	}
}

export function resetCookingProcesses(): void {
	processes.clear();
	pending.clear();
	active = undefined;
}
