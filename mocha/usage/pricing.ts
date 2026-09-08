import { t } from "../shared/i18n/index.ts";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rm,
	stat,
} from "node:fs/promises";
import { dirname } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	applyEdits,
	findNodeAtLocation,
	type JSONPath,
	modify,
	type Node,
	type ParseError,
	parseTree,
} from "jsonc-parser";
import { errorCode } from "./storage.ts";

export const priceFields = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
] as const;
export type Prices = Record<(typeof priceFields)[number], number>;
export interface ModelTarget {
	provider: string;
	model: string;
}
export interface PriceDraft {
	prices: Prices;
	tiered: boolean;
}
export interface PriceActions {
	load(target: ModelTarget): Promise<PriceDraft>;
	save(target: ModelTarget, prices: Prices): Promise<void>;
}

export function parsePrice(value: string): number | undefined {
	if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))
		return undefined;
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function document(text: string): Node {
	const errors: ParseError[] = [];
	const tree = parseTree(text, errors);
	if (!tree || tree.type !== "object" || errors.length)
		throw new Error(t("price.invalidJson"));
	// Duplicate properties make a path ambiguous between parsers; never edit such a document.
	const visit = (node: Node): void => {
		if (node.type === "object") {
			const names = new Set<string>();
			for (const property of node.children ?? []) {
				const name = String(property.children?.[0].value);
				if (names.has(name))
					throw new Error(t("price.duplicateFields"));
				names.add(name);
			}
		}
		for (const child of node.children ?? []) visit(child);
	};
	visit(tree);
	return tree;
}

function paths(
	tree: Node,
	target: ModelTarget,
): { custom?: JSONPath; override: JSONPath; write: JSONPath } {
	const provider = ["providers", target.provider];
	const models = findNodeAtLocation(tree, [...provider, "models"]);
	const matches = (models?.children ?? []).flatMap((model, index) =>
		findNodeAtLocation(model, ["id"])?.value === target.model ? [index] : [],
	);
	if (matches.length > 1)
		throw new Error(t("price.duplicateModels"));
	const custom = matches.length
		? [...provider, "models", matches[0], "cost"]
		: undefined;
	const override = [...provider, "modelOverrides", target.model, "cost"];
	const write =
		findNodeAtLocation(tree, override.slice(0, -1)) || !custom
			? override
			: custom;
	for (let i = 1; i <= write.length; i++) {
		const node = findNodeAtLocation(tree, write.slice(0, i));
		const expected =
			write[i] === matches[0] && write[i - 1] === "models" ? "array" : "object";
		if (node && node.type !== expected)
			throw new Error(t("price.invalidModel"));
	}
	return { custom, override, write };
}

async function readConfig(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

export async function loadPrices(
	file: string,
	target: ModelTarget,
	fallback?: Prices & { tiers?: unknown[] },
): Promise<PriceDraft> {
	const original = await readConfig(file);
	const tree = document((original ?? "{}").replace(/^\uFEFF/, ""));
	const { custom, override } = paths(tree, target);
	const prices = {} as Prices;
	for (const field of priceFields) {
		const value: unknown =
			findNodeAtLocation(tree, [...override, field])?.value ??
			(custom
				? findNodeAtLocation(tree, [...custom, field])?.value
				: undefined) ??
			fallback?.[field] ??
			0;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
			throw new Error(t("price.invalidValue", { field: t(`column.${field}`) }));
		prices[field] = value;
	}
	const tiers =
		findNodeAtLocation(tree, [...override, "tiers"]) ??
		(custom ? findNodeAtLocation(tree, [...custom, "tiers"]) : undefined);
	return {
		prices,
		tiered: tiers
			? Boolean(tiers.children?.length)
			: Boolean(fallback?.tiers?.length),
	};
}

async function writePending(
	file: string,
	data: string,
	mode: number,
): Promise<string> {
	const pending = `${file}.${randomUUID()}.pending`;
	const handle = await open(pending, "wx", mode);
	try {
		await handle.writeFile(data, "utf8");
		await handle.sync();
	} catch (error) {
		await handle.close();
		await rm(pending, { force: true });
		throw error;
	}
	await handle.close();
	return pending;
}

export async function savePrices(
	file: string,
	target: ModelTarget,
	prices: Prices,
): Promise<boolean> {
	for (const field of priceFields) {
		if (!Number.isFinite(prices[field]) || prices[field] < 0)
			throw new Error(t("price.nonNegative", { field: t(`column.${field}`) }));
	}
	try {
		file = await realpath(file);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	const original = await readConfig(file);
	const bom = original?.startsWith("\uFEFF") ? "\uFEFF" : "";
	let text = (original ?? "{}\n").slice(bom.length);
	const tree = document(text);
	const path = paths(tree, target).write;
	const indent = /^([ \t]+)"/m.exec(text)?.[1];
	for (const field of priceFields) {
		text = applyEdits(
			text,
			modify(text, [...path, field], prices[field], {
				formattingOptions: {
					insertSpaces: !indent?.includes("\t"),
					tabSize: indent?.length ?? 2,
					eol: text.includes("\r\n") ? "\r\n" : "\n",
				},
			}),
		);
	}
	document(text);
	const updated = bom + text;
	if (updated === original) return false;
	await mkdir(dirname(file), { recursive: true });
	const mode = original === undefined ? 0o600 : (await stat(file)).mode & 0o777;
	const pending = await writePending(file, updated, mode);
	let backup: string | undefined;
	try {
		if (original !== undefined)
			backup = await writePending(`${file}.usage-backup`, original, 0o600);
		if ((await readConfig(file)) !== original)
			throw new Error(t("price.changed"));
		if (backup) await rename(backup, `${file}.usage-backup`);
		await rename(pending, file);
	} finally {
		await rm(pending, { force: true });
		if (backup) await rm(backup, { force: true });
	}
	return true;
}

export async function refreshPrices(
	pi: Pick<ExtensionAPI, "setModel" | "getThinkingLevel" | "setThinkingLevel">,
	ctx: ExtensionContext,
): Promise<void> {
	await ctx.modelRegistry.refresh({ allowNetwork: false });
	if (ctx.modelRegistry.getError())
		throw new Error(t("price.refreshFailed"));
	const current = ctx.model;
	if (!current) return;
	const next = ctx.modelRegistry.find(current.provider, current.id);
	if (next && JSON.stringify(next.cost) !== JSON.stringify(current.cost)) {
		const thinking = pi.getThinkingLevel();
		if (!(await pi.setModel(next)))
			throw new Error(t("price.modelNotRefreshed"));
		if (ctx.model?.provider === next.provider && ctx.model?.id === next.id)
			pi.setThinkingLevel(thinking);
	}
}
