import { t } from "../shared/i18n/index.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type OverlayHandle, Text } from "@earendil-works/pi-tui";
import type { UsageLedger } from "./ledger.ts";
import { UsagePanel } from "./panel.ts";
import { PriceEditor } from "./price-editor.ts";
import type { PriceActions } from "./pricing.ts";
import type { Progress } from "./types.ts";

export { formatNumber, renderReport } from "./table.ts";

export class UsageJob {
	state: Progress = {
		phase: "recover",
		scanned: 0,
		removed: 0,
		swept: false,
		warnings: [],
	};
	error: string | undefined;
	complete = false;
	readonly promise: Promise<void>;
	private listeners = new Set<() => void>();

	constructor(store: UsageLedger, before: Promise<void> = Promise.resolve()) {
		this.promise = before
			.then(() =>
				store.run((state) => {
					this.state = state;
					this.emit();
				}),
			)
			.then(() => {})
			.catch((error) => {
				this.error = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				this.complete = true;
				this.emit();
			});
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

export class UsageUI {
	private foreground = false;
	private disposed = false;
	private closePanel: (() => void) | undefined;
	private closeToast: (() => void) | undefined;
	private readonly prices:
		| ((ctx: ExtensionContext) => PriceActions)
		| undefined;
	private readonly editors = new Set<PriceEditor>();

	constructor(prices?: (ctx: ExtensionContext) => PriceActions) {
		this.prices = prices;
	}

	async settled(): Promise<void> {
		for (const editor of this.editors) await editor.settled();
	}

	watch(job: UsageJob, ctx: ExtensionContext): void {
		void job.promise.then(() => {
			if (this.disposed || this.foreground || !ctx.hasUI) return;
			this.toast(
				ctx,
				job.error
					? t("usage.failed", { error: job.error })
					: job.state.warnings.length
						? t("usage.retryPending")
						: t("usage.complete"),
			);
		});
	}

	private toast(ctx: ExtensionContext, message: string): void {
		this.closeToast?.();
		void ctx.ui
			.custom<void>(
				(_tui, theme, _keys, done) => {
					const timer = setTimeout(() => done(), 4500);
					this.closeToast = done;
					return {
						render: (width) =>
							new Text(theme.fg("accent", message), 1, 0).render(width),
						invalidate() {},
						dispose: () => {
							clearTimeout(timer);
							this.closeToast = undefined;
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-right",
						width: 48,
						maxHeight: 5,
						margin: 1,
						nonCapturing: true,
					},
				},
			)
			.catch(() => {});
	}

	async show(
		job: UsageJob,
		ctx: ExtensionContext,
		days: number,
	): Promise<void> {
		this.closePanel?.();
		this.closeToast?.();
		this.foreground = true;
		try {
			const modelOrder = ctx.modelRegistry
				.getAll()
				.map((model) => `${model.provider}/${model.id}`);
			await ctx.ui.custom<void>(
				(tui, theme, keys, done) => {
					let editor: PriceEditor | undefined;
					let handle: OverlayHandle | undefined;
					const closeEditor = () => {
						const previous = editor;
						editor = undefined;
						handle?.hide();
						handle = undefined;
						previous?.dispose();
						if (previous)
							void previous
								.settled()
								.finally(() => this.editors.delete(previous));
						tui.requestRender();
					};
					const closePanel = () => {
						closeEditor();
						done();
					};
					this.closePanel = closePanel;
					const panel = new UsagePanel({
						source: job,
						days,
						theme,
						modelOrder,
						rows: () => tui.terminal.rows,
						redraw: () => tui.requestRender(),
						close: closePanel,
						editPrice: this.prices
							? (target) => {
									if (editor || !this.prices) return;
									editor = new PriceEditor({
										target,
										actions: this.prices(ctx),
										theme,
										rows: () => tui.terminal.rows,
										matches: (data, key) => keys.matches(data, key),
										redraw: () => tui.requestRender(),
										close: closeEditor,
									});
									this.editors.add(editor);
									handle = tui.showOverlay(editor, {
										anchor: "center",
										width: 68,
										maxHeight: "90%",
										margin: 1,
									});
								}
							: undefined,
						matches: (data, action) => keys.matches(data, action),
					});
					const unsubscribe = job.subscribe(() => {
						panel.invalidate();
						tui.requestRender();
					});
					return {
						render: (width) => panel.render(width),
						invalidate: () => panel.invalidate(),
						handleInput: (data) =>
							editor ? editor.handleInput(data) : panel.handleInput(data),
						handleMouse: (event) =>
							editor ? { handled: true } : panel.handleMouse(event),
						dispose: () => {
							closeEditor();
							unsubscribe();
							this.closePanel = undefined;
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "100%",
						maxHeight: "80%",
						margin: { top: 1, bottom: 1, left: 2, right: 2 },
					},
				},
			);
		} finally {
			this.foreground = false;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.closePanel?.();
		this.closeToast?.();
	}
}
