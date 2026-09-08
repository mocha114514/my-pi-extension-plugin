// Theme distributor: ships the bundled "mpep-blue" theme and installs it into
// the user's Pi agent directory on first load. Installation is deliberately
// one-shot: once the theme file exists on disk, this extension never touches
// the user's theme selection again (manual choices are respected). Enable /
// disable lifecycle is handled through /m-mng, where disable performs a full
// uninstall (restore previous theme + remove the theme file).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPluginEnabled } from "./manager/preferences.ts";
import { t } from "./shared/i18n/index.ts";
import { getCacheDir } from "./shared/paths.ts";

const PLUGIN_ID = "theme-distributor";
const THEME_NAME = "mpep-blue";
const FALLBACK_THEME = "dark";

interface DistributionState {
	previousTheme?: string;
}

function themeFilePath(): string {
	return join(getAgentDir(), "themes", `${THEME_NAME}.json`);
}

function settingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function statePath(): string {
	return join(getCacheDir(), "theme-state.json");
}

function bundledThemePath(): string {
	return fileURLToPath(new URL("./themes/mpep-blue.json", import.meta.url));
}

/** Write a file atomically (temp file + rename) to avoid partial writes. */
function atomicWrite(file: string, content: string): void {
	const temporary = `${file}.${process.pid}.tmp`;
	mkdirSync(dirname(file), { recursive: true });
	try {
		writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function parseJsonFile(file: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function readDistributionState(): DistributionState {
	return parseJsonFile(statePath()) as DistributionState | undefined ?? {};
}

function readSelectedTheme(): string | undefined {
	const settings = parseJsonFile(settingsPath());
	return typeof settings?.theme === "string" ? settings.theme : undefined;
}

function writeSelectedTheme(theme: string): void {
	const settings = parseJsonFile(settingsPath()) ?? {};
	atomicWrite(settingsPath(), `${JSON.stringify({ ...settings, theme }, null, 2)}\n`);
}

/**
 * Install the bundled theme and (on a genuine first install) select it.
 * Returns a user-facing notification message, or undefined when nothing changed.
 */
export function installTheme(): string | undefined {
	const file = themeFilePath();

	// The theme file already exists: never touch settings.json again, the user
	// may have picked another theme on purpose.
	if (existsSync(file)) return undefined;

	atomicWrite(file, readFileSync(bundledThemePath(), "utf8"));

	// Remember the previous selection so /m-mng disable can restore it.
	const previous = readSelectedTheme() ?? FALLBACK_THEME;
	const state: DistributionState = { previousTheme: previous };
	atomicWrite(statePath(), `${JSON.stringify(state, null, 2)}\n`);

	writeSelectedTheme(THEME_NAME);
	return t("theme.installed", { theme: THEME_NAME, previous });
}

/**
 * Uninstall: remove the theme file and restore the theme recorded at install
 * time (falling back to Pi's default "dark"). Safe to call repeatedly.
 */
export function uninstallTheme(): string | undefined {
	rmSync(themeFilePath(), { force: true });

	const { previousTheme } = readDistributionState();
	rmSync(statePath(), { force: true });

	if (readSelectedTheme() === THEME_NAME) {
		writeSelectedTheme(previousTheme ?? FALLBACK_THEME);
	}
	return t("theme.uninstalled", { theme: THEME_NAME });
}

export default function themeDistributorExtension(pi: ExtensionAPI) {
	// Opt-out gate follows the shared m-mng conventions.
	if (!isPluginEnabled(PLUGIN_ID)) return;

	// Do the (idempotent) filesystem work at load time; surface the outcome
	// once a session UI is available.
	let notice: string | undefined;
	let failed = false;
	try {
		notice = installTheme();
	} catch (error) {
		failed = true;
		notice = t("theme.installFailed", { error: error instanceof Error ? error.message : String(error) });
	}

	pi.on("session_start", (_event, ctx) => {
		if (!notice || !ctx.hasUI) return;
		ctx.ui.notify(notice, failed ? "error" : "info");
	});
}
