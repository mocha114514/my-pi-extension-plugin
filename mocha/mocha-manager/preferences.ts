import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "../shared/i18n/index.ts";
import { getMochaDir } from "../shared/paths.ts";

export interface MochaRegistryItem {
	id: string;
	name: string;
	path: string;
	desc: string;
	enabled: boolean;
}
interface Preferences extends Record<string, unknown> {
	version: 1;
	enabled: Record<string, boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readRegistry(): MochaRegistryItem[] {
	const file = fileURLToPath(new URL("./mocha-registry.json", import.meta.url));
	const value: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!Array.isArray(value) || !value.every(item => isRecord(item) &&
		["id", "name", "path", "desc"].every(key => typeof item[key] === "string") && typeof item.enabled === "boolean") ||
		new Set(value.map(item => item.id)).size !== value.length) throw new Error(t("manager.invalidRegistry"));
	return value;
}

function readPreferences(file: string): Preferences | undefined {
	let text: string;
	try { text = readFileSync(file, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	try {
		const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
		if (!isRecord(value) || value.version !== 1 || !isRecord(value.enabled) ||
			!Object.values(value.enabled).every(enabled => typeof enabled === "boolean")) throw new Error("Invalid preferences");
		return value as Preferences;
	} catch { throw new Error(t("manager.invalidPreferences")); }
}

export function writePluginStates(changes: Record<string, boolean>): void {
	const file = join(getMochaDir(), "plugins.json");
	const previous = readPreferences(file) ?? { version: 1, enabled: {} };
	const next = { ...previous, enabled: { ...previous.enabled, ...changes } };
	const temporary = `${file}.${randomUUID()}.tmp`;
	mkdirSync(dirname(file), { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporary, file);
	} finally { rmSync(temporary, { force: true }); }
}

export function loadRegistry(): MochaRegistryItem[] {
	const items = readRegistry();
	const preferences = readPreferences(join(getMochaDir(), "plugins.json"));
	return items.map(item => ({ ...item, enabled: preferences && Object.hasOwn(preferences.enabled, item.id)
		? preferences.enabled[item.id] : item.enabled }));
}

/** Evaluated at extension load, never on each render or message. */
export function isPluginEnabled(id: string): boolean {
	return loadRegistry().find(item => item.id === id)?.enabled ?? true;
}
