import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { ToolPresentationContext } from "./extension_types.ts";
import { createResultMouseRegion, createToolCallMouseRegion } from "./mouse_interaction_handler.ts";
import { sanitizeCommand, setLatestTheme, shortenPath } from "./summary_preview_renderer.ts";
import { getTurnId, turnStates } from "./turn_state_manager.ts";

function handleCall(callText: string, context: ToolPresentationContext, theme: Theme) {
	setLatestTheme(theme);
	const turnId = getTurnId(context.toolCallId);
	const callComp = new Text(callText, 0, 0);
	return turnId === undefined
		? callComp
		: createToolCallMouseRegion(callComp, context.toolCallId, turnId, callText, context);
}
function handleResult(resultText: string, context: ToolPresentationContext, theme: Theme) {
	setLatestTheme(theme);
	const turnId = getTurnId(context.toolCallId);
	const tool = turnId === undefined ? undefined : turnStates.get(turnId)?.tools.get(context.toolCallId);
	if (tool && !tool.isExpanded) return new Text("", 0, 0);
	const resultComp: Component = new Text(
		resultText ? `\n${theme.fg(context.isError ? "error" : "toolOutput", resultText)}` : "",
		0,
		0,
	);
	return turnId === undefined ? resultComp : createResultMouseRegion(resultComp, turnId);
}

function createResultRenderer(trim: boolean): NonNullable<ToolDefinition["renderResult"]> {
	return (result, _options, theme, context) => {
		const text = result.content.find((content) => content.type === "text")?.text ?? "";
		return handleResult(trim ? text.trim() : text, context, theme);
	};
}

const renderResult = createResultRenderer(false);
const renderTrimmedResult = createResultRenderer(true);

export function registerBuiltInTools(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	pi.registerTool({
		...createReadToolDefinition(cwd),
		renderShell: "self",
		renderResult,

		renderCall(args, theme, context) {
			const path = shortenPath(args.path || "");
			let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			if (args.offset !== undefined || args.limit !== undefined) {
				const startLine = args.offset ?? 1;
				const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
				pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			const callText = `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;
			return handleCall(callText, context, theme);
		},
	});

	pi.registerTool({
		...createBashToolDefinition(cwd),
		renderShell: "self",
		renderResult: renderTrimmedResult,

		renderCall(args, theme, context) {
			const cmd = sanitizeCommand(args.command);
			const timeout = args.timeout;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			const callText = `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", cmd)}${timeoutSuffix}`;
			return handleCall(callText, context, theme);
		},
	});

	pi.registerTool({
		...createPowerShellToolDefinition(cwd),
		renderShell: "self",
		renderResult: renderTrimmedResult,

		renderCall(args, theme, context) {
			const cmd = sanitizeCommand(args.command);
			const timeout = args.timeout;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
			const callText = `${theme.fg("toolTitle", theme.bold("PS>"))} ${theme.fg("accent", cmd)}${timeoutSuffix}`;
			return handleCall(callText, context, theme);
		},
	});

	pi.registerTool({
		...createWriteToolDefinition(cwd),
		renderShell: "self",
		renderResult,

		renderCall(args, theme, context) {
			const path = shortenPath(args.path || "");
			const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			const lineCount = args.content ? args.content.split("\n").length : 0;
			const lineInfo = lineCount > 0 ? theme.fg("muted", ` (${lineCount} lines)`) : "";
			const callText = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}${lineInfo}`;
			return handleCall(callText, context, theme);
		},
	});

	pi.registerTool({
		...createEditToolDefinition(cwd),
		renderShell: "self",
		renderResult,

		renderCall(args, theme, context) {
			const path = shortenPath(args.path || "");
			const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			const callText = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
			return handleCall(callText, context, theme);
		},
	});

	pi.registerTool({
		...createFindToolDefinition(cwd),
		renderShell: "self",
		renderResult: renderTrimmedResult,

		renderCall(args, theme, context) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			const callText = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)} in ${path}`;
			return handleCall(callText, context, theme);
		},
	});

	pi.registerTool({
		...createGrepToolDefinition(cwd),
		renderShell: "self",
		renderResult: renderTrimmedResult,

		renderCall(args, theme, context) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			const callText = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${pattern}/`)} in ${path}`;
			return handleCall(callText, context, theme);
		},
	});

	pi.registerTool({
		...createLsToolDefinition(cwd),
		renderShell: "self",
		renderResult: renderTrimmedResult,

		renderCall(args, theme, context) {
			const path = shortenPath(args.path || ".");
			const callText = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}`;
			return handleCall(callText, context, theme);
		},
	});
}
