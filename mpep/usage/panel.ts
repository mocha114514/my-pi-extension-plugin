import type { Theme } from "@earendil-works/pi-coding-agent";
import { t } from "../shared/i18n/index.ts";
import type {
	Component,
	TuiMouseEvent,
	TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	ScrollView,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ModelTarget } from "./pricing.ts";
import {
	buildReport,
	type HeaderCell,
	type ModelCell,
	type ReportSource,
	type SortColumn,
	type SortOrder,
} from "./table.ts";

type PanelKey =
	| "tui.select.cancel"
	| "tui.select.confirm"
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.altScreen.top"
	| "tui.altScreen.bottom";

export interface PanelOptions {
	source: ReportSource;
	days: number;
	theme: Theme;
	modelOrder: readonly string[];
	rows(): number;
	redraw(): void;
	close(): void;
	editPrice?(target: ModelTarget): void;
	matches(data: string, action: PanelKey): boolean;
}

export class UsagePanel implements Component {
	private readonly options: PanelOptions;
	private readonly scroll: ScrollView;
	private body: string[] = [];
	private cells: HeaderCell[] = [];
	private models: ModelCell[] = [];
	private sort: SortOrder | undefined;
	private hovered: SortColumn | undefined;
	private hoveredModel: string | undefined;
	private renderedWidth = 0;
	private renderedHeight = 0;
	private bodyCount = 0;

	constructor(options: PanelOptions) {
		this.options = options;
		this.scroll = new ScrollView(
			{ invalidate() {}, render: () => this.body },
			{ overscroll: "contain" },
		);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.hoveredModel = undefined;
		const matches = (action: PanelKey) => this.options.matches(data, action);
		if (matches("tui.select.cancel") || matches("tui.select.confirm"))
			this.options.close();
		else if (matches("tui.select.up")) this.scroll.scrollBy(-1);
		else if (matches("tui.select.down")) this.scroll.scrollBy(1);
		else if (matches("tui.select.pageUp"))
			this.scroll.scrollBy(-this.scroll.viewportHeight);
		else if (matches("tui.select.pageDown"))
			this.scroll.scrollBy(this.scroll.viewportHeight);
		else if (matches("tui.altScreen.top")) this.scroll.scrollToStart();
		else if (matches("tui.altScreen.bottom")) this.scroll.scrollToEnd();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (
			event.x < 0 ||
			event.x >= this.renderedWidth ||
			event.y < 0 ||
			event.y >= this.renderedHeight
		)
			return undefined;
		if (event.type === "wheel") {
			this.hoveredModel = undefined;
			this.scroll.scrollBy(event.wheelDelta ?? 0);
			return { handled: true, render: true };
		}
		const cell = this.cells.find(
			(cell) =>
				event.y === cell.y &&
				event.x >= cell.x &&
				event.x < cell.x + cell.width,
		);
		const model = this.models.find(
			(cell) =>
				event.y === cell.y &&
				event.x >= cell.x &&
				event.x < cell.x + cell.width,
		);
		if (event.type === "move") {
			const modelKey = model ? `${model.provider}/${model.model}` : undefined;
			if (this.hovered === cell?.column && this.hoveredModel === modelKey)
				return { handled: true };
			this.hovered = cell?.column;
			this.hoveredModel = modelKey;
			return { handled: true, render: true };
		}
		if (event.type === "click" && event.button === "left" && cell) {
			this.hoveredModel = undefined;
			this.sort = {
				column: cell.column,
				descending:
					this.sort?.column === cell.column ? !this.sort.descending : true,
			};
			this.scroll.scrollToStart();
			this.options.redraw();
			return { handled: true, render: true };
		}
		if (event.type === "click" && event.button === "left") {
			if (model)
				this.options.editPrice?.({
					provider: model.provider,
					model: model.model,
				});
		}
		return { handled: true };
	}

	render(width: number): string[] {
		if (width !== this.renderedWidth) this.hoveredModel = undefined;
		this.renderedWidth = width;
		this.cells = [];
		this.models = [];
		if (width < 6) return [" ".repeat(Math.max(0, width))];
		const { source, days, theme, modelOrder } = this.options;
		const inner = width - 4;
		const view = buildReport(
			source,
			days,
			theme,
			inner,
			modelOrder,
			this.sort,
			this.hovered,
			this.hoveredModel,
		);
		const maxHeight = Math.max(
			3,
			Math.min(Math.floor(this.options.rows() * 0.8), this.options.rows() - 2),
		);
		const headers = view.headers.slice(0, Math.max(0, maxHeight - 4));
		const status = maxHeight >= headers.length + 7 ? [view.status] : [];
		const topCount = 1 + status.length + headers.length + 1;
		const remaining = maxHeight - topCount - 1;
		const total = remaining >= view.total.length + 3 ? view.total : [];
		const footer =
			remaining >= total.length + 5
				? view.footers.slice(0, Math.min(2, remaining - total.length - 4))
				: [];
		const bottomCount =
			(total.length ? total.length + 1 : 0) + footer.length + 1;
		this.body = view.body;
		this.bodyCount = Math.max(
			0,
			Math.min(this.body.length, maxHeight - topCount - bottomCount),
		);
		this.scroll.updateLayout(this.body.length, this.bodyCount, () =>
			this.options.redraw(),
		);
		this.models = view.models
			.filter(
				(cell) =>
					cell.y >= this.scroll.scrollTop &&
					cell.y < this.scroll.scrollTop + this.bodyCount,
			)
			.map((cell) => ({
				...cell,
				x: cell.x + 2,
				y: cell.y - this.scroll.scrollTop + topCount,
			}));
		this.cells = view.cells
			.filter((cell) => cell.y < headers.length)
			.map((cell) => ({
				...cell,
				x: cell.x + 2,
				y: cell.y + 1 + status.length,
			}));
		const label = truncateToWidth(
			` ${t("usage.title", { period: days ? t("usage.recentDays", { days }) : t("usage.allHistory") })} `,
			width - 2,
			"",
		);
		const top = theme.fg(
			"border",
			`\u250c${label}${"\u2500".repeat(width - 2 - visibleWidth(label))}\u2510`,
		);
		const divider = theme.fg(
			"border",
			`\u251c${"\u2500".repeat(width - 2)}\u2524`,
		);
		const bottom = theme.fg(
			"border",
			`\u2514${"\u2500".repeat(width - 2)}\u2518`,
		);
		const frame = (line: string, right = theme.fg("border", "\u2502")) => {
			const text = truncateToWidth(line, inner, "\u2026");
			return `${theme.fg("border", "\u2502")} ${text}${" ".repeat(inner - visibleWidth(text))} ${right}`;
		};
		const visible = this.scroll
			.render(inner)
			.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.bodyCount);
		const thumbSize = Math.max(
			1,
			Math.floor((this.bodyCount * this.bodyCount) / this.body.length),
		);
		const maxScroll = this.body.length - this.bodyCount;
		const thumbTop =
			maxScroll > 0
				? Math.round(
						(this.scroll.scrollTop / maxScroll) * (this.bodyCount - thumbSize),
					)
				: 0;
		const lines = [
			top,
			...status.map((line) => frame(line)),
			...headers.map((line) => frame(line)),
			divider,
			...visible.map((line, index) =>
				frame(
					line,
					maxScroll > 0 && index >= thumbTop && index < thumbTop + thumbSize
						? theme.fg("accent", "\u2503")
						: undefined,
				),
			),
			...(total.length ? [divider, ...total.map((line) => frame(line))] : []),
			...footer.map((line) => frame(theme.fg("dim", line))),
			bottom,
		];
		this.renderedHeight = lines.length;
		return lines;
	}
}
