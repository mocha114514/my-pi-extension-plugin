import { t } from "../shared/i18n/index.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	type MarkdownTransformer,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createCookingBody, createCookingHeader, createCookingSeparator } from "./cooking_process_components.ts";
import { createSummaryMouseRegion, isBlankDoubleClick } from "./mouse_interaction_handler.ts";
import {
	formatPreview,
	getActivePreview,
	getLatestTheme,
	renderSummary,
	toolHeader,
} from "./summary_preview_renderer.ts";
import {
	getMessageState,
	setAllGlobalExpanded,
	toggleTurnExpanded,
	toolCallTurnMap,
	toolViews,
	turnStates,
} from "./turn_state_manager.ts";

class FixedLines implements Component {
	private lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, Math.max(1, width), "..."));
	}
	invalidate(): void {}
}

class ActivityGroupComponent extends Container {
	private groupId: number;
	private markdownTheme: MarkdownTheme;
	private lastLines: string[] = [];
	constructor(groupId: number, markdownTheme: MarkdownTheme) {
		super();
		this.groupId = groupId;
		this.markdownTheme = markdownTheme;
	}

	// Native tool rows are invalidated by Pi, not by the summary's refresh path.
	override invalidate(): void {}

	override render(width: number): string[] {
		this.clear();
		const group = turnStates.get(this.groupId);
		if (!group) return [];
		const theme = getLatestTheme();
		this.addChild(createSummaryMouseRegion(new FixedLines([renderSummary(group, theme)]), group.id));
		if (!group.expanded) {
			const preview = getActivePreview(group);
			if (preview) this.addChild(new FixedLines(formatPreview(preview, theme, width)));
		} else {
			for (const activity of group.activities) {
				if (activity.type === "tool") {
					const view = toolViews.get(activity.toolCallId);
					const tool = group.tools.get(activity.toolCallId);
					if (view) this.addChild(view);
					else if (tool) this.addChild(new Text(toolHeader(tool), 0, 0));
				} else {
					this.addChild(new Spacer(1));
					const content = activity.isExpanded
						? new Markdown(activity.output, 0, 0, this.markdownTheme, {
								color: (text) => theme.fg("thinkingText", text),
								italic: true,
							})
						: new Text(theme.italic(theme.fg("thinkingText", t("activity.thinkingPending"))), 0, 0);
					this.addChild(
						new MouseRegion(content, (event) => {
							if (event.button !== "left" || event.type !== "click") return;
							if (event.x >= visibleWidth(content.render(event.width)[event.y] ?? "")) {
								if (isBlankDoubleClick(event, group.id)) toggleTurnExpanded(group.id);
							} else {
								activity.isExpanded = !activity.isExpanded;
								group.refresh?.();
							}
							return { handled: true };
						}),
					);
				}
			}
		}
		this.lastLines = super.render(width);
		return this.lastLines;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		const result = super.handleMouse(event);
		if (result) return result;
		const group = turnStates.get(this.groupId);
		if (group?.expanded && event.button === "left" && event.x >= visibleWidth(this.lastLines[event.y] ?? "")) {
			const target = {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			};
			if (event.type === "press") return { handled: true, target };
			if (event.type === "click") {
				if (isBlankDoubleClick(event, group.id)) toggleTurnExpanded(group.id);
				return { handled: true, target };
			}
		}
		return undefined;
	}
}

// Pi does not expose an assistant renderer hook. Keep private-field access in this adapter only.
interface AssistantInternals {
	contentContainer: Container;
	markdownTheme: MarkdownTheme;
	hiddenThinkingLabel: string;
	outputPad: number;
	markdownTransformers: readonly MarkdownTransformer[];
	lastMessage?: AssistantMessage;
	isStreaming: boolean;
}

interface ToolInternals {
	toolCallId: string;
	updateDisplay(): void;
}

export function installActivityComponents(): () => void {
	const assistantPrototype = AssistantMessageComponent.prototype;
	const toolPrototype = ToolExecutionComponent.prototype;
	const toolInternals = toolPrototype as unknown as ToolInternals;
	const originalUpdate = assistantPrototype.updateContent;
	const originalRender = toolPrototype.render;
	const originalMouse = toolPrototype.handleMouse;
	const originalDisplay = toolInternals.updateDisplay;
	const originalExpanded = toolPrototype.setExpanded;
	const previousExpanded = Object.getOwnPropertyDescriptor(assistantPrototype, "setExpanded");
	const nativeSlices = new WeakSet<AssistantMessageComponent>();
	const refreshes = new WeakMap<AssistantMessageComponent, () => void>();
	const setExpanded = function (this: AssistantMessageComponent, value: boolean): void {
		setAllGlobalExpanded(value);
	};
	Object.defineProperty(assistantPrototype, "setExpanded", { configurable: true, writable: true, value: setExpanded });

	const update = function (this: AssistantMessageComponent, message: AssistantMessage, streaming?: boolean): void {
		const state = nativeSlices.has(this) ? undefined : getMessageState(message);
		if (!state) {
			originalUpdate.call(this, message, streaming);
			return;
		}
		const internals = this as unknown as AssistantInternals;
		const isStreaming = streaming ?? internals.isStreaming;
		// Let Pi produce its native stop/error diagnostics, then insert the activity timeline before them.
		originalUpdate.call(
			this,
			{ ...message, content: message.content.filter((block) => block.type === "toolCall") },
			isStreaming,
		);
		const diagnostics = [...internals.contentContainer.children];
		internals.contentContainer.clear();
		internals.lastMessage = message;
		let refresh = refreshes.get(this);
		if (!refresh) {
			refresh = () => this.invalidate();
			refreshes.set(this, refresh);
		}
		state.refresh = refresh;
		const process = state.process;
		const fold = process?.fold;
		if (process && fold?.anchorMessageId === state.id) {
			internals.contentContainer.addChild(new Spacer(1));
			internals.contentContainer.addChild(createCookingHeader(process));
		}
		const body = new Container();
		if (process && fold && process.expanded) internals.contentContainer.addChild(createCookingBody(body, process));
		for (let index = 0; index < state.parts.length; index++) {
			const part = state.parts[index];
			const isFinal = fold?.finalMessageId === state.id && index >= fold.finalPartIndex;
			if (fold && !isFinal && !process?.expanded) continue;
			const container = fold && !isFinal ? body : internals.contentContainer;
			if (fold?.finalMessageId === state.id && index === fold.finalPartIndex) {
				container.addChild(new Spacer(1));
				container.addChild(createCookingSeparator());
			}
			if (part.type === "group") {
				const group = turnStates.get(part.groupId);
				if (!group) continue;
				group.refresh = refresh;
				container.addChild(new Spacer(1));
				container.addChild(new ActivityGroupComponent(group.id, internals.markdownTheme));
			} else {
				const block = message.content[part.index];
				if (block?.type !== "text") continue;
				const slice = new AssistantMessageComponent(
					undefined,
					true,
					internals.markdownTheme,
					internals.hiddenThinkingLabel,
					internals.outputPad,
					internals.markdownTransformers,
				);
				nativeSlices.add(slice);
				originalUpdate.call(slice, { ...message, content: [block], stopReason: "stop" }, isStreaming);
				container.addChild((slice as unknown as AssistantInternals).contentContainer);
			}
		}
		for (const diagnostic of diagnostics) (fold ? body : internals.contentContainer).addChild(diagnostic);
	};
	assistantPrototype.updateContent = update;

	const display = function (this: ToolExecutionComponent): void {
		originalDisplay.call(this);
		const id = (this as unknown as ToolInternals).toolCallId;
		if (!toolCallTurnMap.has(id)) return;
		toolViews.set(id, {
			render: (width) => originalRender.call(this, width),
			handleMouse: (event: TuiMouseEvent) => originalMouse.call(this, event),
			invalidate: () => this.invalidate(),
			setExpanded: (value) => originalExpanded.call(this, value),
		});
	};
	toolInternals.updateDisplay = display;
	const render = function (this: ToolExecutionComponent, width: number): string[] {
		return toolCallTurnMap.has((this as unknown as ToolInternals).toolCallId) ? [] : originalRender.call(this, width);
	};
	toolPrototype.render = render;
	return () => {
		if (assistantPrototype.updateContent === update) assistantPrototype.updateContent = originalUpdate;
		if (toolPrototype.render === render) toolPrototype.render = originalRender;
		if (toolInternals.updateDisplay === display) toolInternals.updateDisplay = originalDisplay;
		if (Object.getOwnPropertyDescriptor(assistantPrototype, "setExpanded")?.value === setExpanded) {
			if (previousExpanded) Object.defineProperty(assistantPrototype, "setExpanded", previousExpanded);
			else Reflect.deleteProperty(assistantPrototype, "setExpanded");
		}
	};
}
