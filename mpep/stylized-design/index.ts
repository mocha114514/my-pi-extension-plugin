import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { registerBuiltInTools } from "./builtin_tools_override.ts";
import { separateCookingProcess } from "./cooking_process_state.ts";
import { applyPatches } from "./core_components_patcher.ts";
import { setupMarkdownEnhancements } from "./markdown_rendering_enhancer.ts";
import { setupMcpCoordinator } from "./mcp_tools_coordinator.ts";
import { resetMouseTiming } from "./mouse_interaction_handler.ts";
// Note: editor/keyboard enhancements were extracted into the standalone
// "terminal-interaction" plugin (see ../terminal-interaction/).
import { setLatestTheme } from "./summary_preview_renderer.ts";
import {
	endLiveCollection,
	finishAssistant,
	observeAssistant,
	observeToolResult,
	resetTurnState,
	sealActiveGroup,
	syncFromSessionHistory,
} from "./turn_state_manager.ts";

export default function (pi: ExtensionAPI): void {
	if (!isPluginEnabled("stylized-design")) return;
	const disposePatches = applyPatches();
	const disposeMarkdown = setupMarkdownEnhancements(pi);
	const disposeMcp = setupMcpCoordinator();
	registerBuiltInTools(pi);
	const restoreSession = (_event: unknown, ctx: ExtensionContext) => {
		resetMouseTiming();
		setLatestTheme(ctx.ui.theme);
		syncFromSessionHistory(ctx.sessionManager.getBranch(), !ctx.isIdle());
	};
	pi.on("session_start", restoreSession);
	pi.on("session_compact", restoreSession);
	pi.on("session_tree", restoreSession);
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") observeAssistant(event.message, true);
		else if (event.message.role !== "toolResult") {
			sealActiveGroup();
			separateCookingProcess();
		}
	});
	pi.on("message_update", (event) => {
		if (event.message.role === "assistant") observeAssistant(event.message);
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") finishAssistant(event.message);
		else if (event.message.role === "toolResult")
			observeToolResult(event.message.toolCallId, event.message, false, event.message.isError);
	});
	pi.on("tool_execution_update", (event) => observeToolResult(event.toolCallId, event.partialResult, true, false));
	pi.on("tool_execution_end", (event) => observeToolResult(event.toolCallId, event.result, false, event.isError));
	pi.on("agent_end", endLiveCollection);
	pi.on("session_shutdown", () => {
		disposeMarkdown();
		disposePatches();
		disposeMcp();
		resetTurnState();
	});
}
