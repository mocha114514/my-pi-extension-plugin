import type { Theme } from "@earendil-works/pi-coding-agent";
import { t } from "../shared/i18n/index.ts";
import {
	type Component,
	type Focusable,
	Input,
	stripTerminalSequences,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	type ModelTarget,
	type PriceActions,
	type Prices,
	parsePrice,
	priceFields,
} from "./pricing.ts";

export const historyPriceNotice = () => t("price.historyNotice");
type PriceKey =
	| "tui.select.cancel"
	| "tui.input.tab"
	| "tui.select.up"
	| "tui.select.down"
	| "tui.input.submit";
interface EditorOptions {
	target: ModelTarget;
	actions: PriceActions;
	theme: Theme;
	rows(): number;
	matches(data: string, key: PriceKey): boolean;
	redraw(): void;
	close(): void;
}

export class PriceEditor implements Component, Focusable {
	private readonly options: EditorOptions;
	private readonly inputs = priceFields.map(() => new Input());
	private active = 0;
	private isFocused = false;
	private loaded = false;
	private disposed = false;
	private saving = false;
	private tiered = false;
	private error = "";
	private positions: { x: number; y: number; index: number; width: number }[] =
		[];
	private pending: Promise<void>;
	private initial: Prices | undefined;
	private scrollOffset = 0;
	private maxScroll = 0;
	private revealField = true;

	constructor(options: EditorOptions) {
		this.options = options;
		this.pending = options.actions
			.load(options.target)
			.then((draft) => {
				this.initial = draft.prices;
				this.tiered = draft.tiered;
				for (const [index, field] of priceFields.entries())
					this.inputs[index].setValue(String(draft.prices[field]));
				this.loaded = true;
			})
			.catch((error: unknown) => {
				this.error = error instanceof Error ? error.message : t("price.readFailed");
			})
			.finally(() => {
				if (!this.disposed) options.redraw();
			});
	}

	get focused(): boolean {
		return this.isFocused;
	}
	set focused(value: boolean) {
		this.isFocused = value;
		this.inputs.forEach((input, index) => {
			input.focused = value && index === this.active;
		});
	}
	invalidate(): void {}
	dispose(): void {
		this.disposed = true;
	}
	async settled(): Promise<void> {
		await this.pending;
	}

	private commit(): void {
		if (this.saving || this.disposed) return;
		if (!this.loaded) {
			if (this.error) this.options.close();
			return;
		}
		const prices = {} as Prices;
		for (const [index, field] of priceFields.entries()) {
			const value = parsePrice(this.inputs[index].getValue());
			if (value === undefined) {
				this.active = index;
				this.focused = this.isFocused;
				this.error = t("price.nonNegative", { field: t(`column.${field}`) });
				this.revealField = true;
				this.options.redraw();
				return;
			}
			prices[field] = value;
		}
		if (priceFields.every((field) => prices[field] === this.initial?.[field])) {
			this.options.close();
			return;
		}
		this.saving = true;
		this.error = "";
		this.options.redraw();
		this.pending = this.options.actions
			.save(this.options.target, prices)
			.then(() => {
				if (!this.disposed) this.options.close();
			})
			.catch((error: unknown) => {
				this.error = error instanceof Error ? error.message : t("price.saveFailed");
			})
			.finally(() => {
				this.saving = false;
				if (!this.disposed) this.options.redraw();
			});
	}

	handleInput(data: string): void {
		if (this.saving) return;
		const match = (key: PriceKey) => this.options.matches(data, key);
		if (match("tui.select.cancel")) {
			this.commit();
			return;
		}
		if (!this.loaded) return;
		if (
			match("tui.input.tab") ||
			match("tui.select.down") ||
			match("tui.input.submit")
		)
			this.active = (this.active + 1) % this.inputs.length;
		else if (match("tui.select.up"))
			this.active = (this.active + this.inputs.length - 1) % this.inputs.length;
		else this.inputs[this.active].handleInput(data);
		this.focused = this.isFocused;
		this.revealField = true;
		this.options.redraw();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
		if (event.type === "wheel") {
			this.scrollOffset = Math.max(
				0,
				Math.min(this.maxScroll, this.scrollOffset + (event.wheelDelta ?? 0)),
			);
			this.revealField = false;
			return { handled: true, render: true };
		}
		if (!this.loaded || this.saving) return { handled: true };
		const position = this.positions.find(
			(item) =>
				event.y === item.y && event.x >= 2 && event.x < item.x + item.width,
		);
		if (position && event.button === "left" && event.type === "press") {
			this.active = position.index;
			this.revealField = true;
			this.focused = this.isFocused;
			this.inputs[this.active].handleMouse({
				...event,
				x: Math.max(0, event.x - position.x),
				y: 0,
			});
			return { handled: true, render: true };
		}
		return { handled: true };
	}

	render(width: number): string[] {
		if (width < 6) return [" ".repeat(Math.max(0, width))];
		const { theme, target } = this.options;
		const inner = width - 4;
		const title = truncateToWidth(t("price.title"), width - 2, "");
		const border = (left: string, right: string, label = "") =>
			theme.fg(
				"border",
				left + label + "\u2500".repeat(width - 2 - visibleWidth(label)) + right,
			);
		const frame = (line: string) => {
			const display = truncateToWidth(line, inner, "");
			return `${theme.fg("border", "\u2502")} ${display}${" ".repeat(inner - visibleWidth(display))} ${theme.fg("border", "\u2502")}`;
		};
		const name = stripTerminalSequences(
			`${target.provider}/${target.model}`,
		).replace(/[\r\n\t]/g, " ");
		const content = new Text(theme.bold(name), 0, 0).render(inner);
		content.push(theme.fg("dim", "USD / 1M tokens"));
		const status =
			this.error ||
			(this.saving ? t("price.saving") : this.loaded ? "" : t("price.reading"));
		if (status)
			content.push(
				...new Text(
					theme.fg(this.error ? "error" : "dim", status),
					0,
					0,
				).render(inner),
			);
		const fieldStart = content.length;
		const prefixWidth = Math.min(11, Math.max(0, inner - 5));
		this.positions = [];
		for (const [index, field] of priceFields.entries()) {
			const fieldLabel = truncateToWidth(t(`column.${field}`), prefixWidth, "");
			const label = fieldLabel + " ".repeat(prefixWidth - visibleWidth(fieldLabel));
			const value = this.loaded
				? index === this.active
					? this.inputs[index].render(inner - prefixWidth)[0]
					: `> ${this.inputs[index].getValue()}`
				: "...";
			content.push(
				`${theme.fg(index === this.active ? "accent" : "text", label)}${value}`,
			);
		}
		content.push("");
		content.push(
			...new Text(theme.fg("dim", historyPriceNotice()), 0, 0).render(inner),
		);
		if (this.tiered)
			content.push(
				...new Text(theme.fg("dim", t("price.tiersPreserved")), 0, 0).render(
					inner,
				),
			);
		const available = Math.max(
			1,
			Math.min(Math.floor(this.options.rows() * 0.9), this.options.rows() - 2) -
				2,
		);
		this.maxScroll = Math.max(0, content.length - available);
		this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll);
		if (this.revealField) {
			const activeRow = fieldStart + this.active;
			if (activeRow < this.scrollOffset) this.scrollOffset = activeRow;
			if (activeRow >= this.scrollOffset + available)
				this.scrollOffset = activeRow - available + 1;
			this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll);
			this.revealField = false;
		}
		const start = this.scrollOffset;
		for (const [index] of priceFields.entries()) {
			const y = 1 + fieldStart + index - start;
			if (y > 0 && y <= available)
				this.positions.push({
					x: 2 + prefixWidth,
					y,
					index,
					width: inner - prefixWidth,
				});
		}
		return [
			border("\u250c", "\u2510", title),
			...content.slice(start, start + available).map(frame),
			border("\u2514", "\u2518"),
		];
	}
}
