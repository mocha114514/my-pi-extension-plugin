// Sync Pi's terminal.hyperlinks override with the path-links plugin gate.
// Settings are written so Pi's own applyRuntimeSettings keeps the value.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides, type TerminalCapabilities } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCacheDir } from "../shared/paths.ts";

const PLUGIN_ID = "path-links";
type HyperlinksSetting = boolean | "auto";

interface PathLinkState {
	applied: boolean;
	previous: HyperlinksSetting | null;
}

function agentSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function statePath(): string {
	return join(getCacheDir(), `${PLUGIN_ID}.json`);
}

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

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
	}
}

function readState(): PathLinkState {
	const raw = readJson(statePath()) ?? {};
	const previous = raw.previous;
	return {
		applied: raw.applied === true,
		previous: previous === true || previous === false || previous === "auto" ? previous : null,
	};
}

function writeState(state: PathLinkState): void {
	atomicWrite(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

function isHyperlinksSetting(value: unknown): value is HyperlinksSetting {
	return value === true || value === false || value === "auto";
}

function readTerminal(): Record<string, unknown> {
	const terminal = readJson(agentSettingsPath())?.terminal;
	return terminal && typeof terminal === "object" && !Array.isArray(terminal) ? (terminal as Record<string, unknown>) : {};
}

function readHyperlinksSetting(): HyperlinksSetting | null {
	const value = readTerminal().hyperlinks;
	return isHyperlinksSetting(value) ? value : null;
}

function writeHyperlinksSetting(value: HyperlinksSetting | null): void {
	const path = agentSettingsPath();
	const parsed = readJson(path);
	if (parsed === undefined && existsSync(path)) return;
	const settings = parsed ?? {};
	const terminal = { ...readTerminal() };
	if (value === null) delete terminal.hyperlinks;
	else terminal.hyperlinks = value;
	if (Object.keys(terminal).length === 0) delete settings.terminal;
	else settings.terminal = terminal;
	atomicWrite(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function overridesFromSettings(): Partial<TerminalCapabilities> {
	const terminal = readTerminal();
	const images = terminal.images;
	const trueColor = terminal.trueColor;
	const hyperlinks = terminal.hyperlinks;
	return {
		...(images === "kitty" || images === "iterm2" ? { images } : images === false ? { images: null } : {}),
		...(typeof trueColor === "boolean" ? { trueColor } : {}),
		...(typeof hyperlinks === "boolean" ? { hyperlinks } : {}),
	};
}

/** Enable OSC 8. Idempotent: the original setting is snapshotted only once. */
export function enablePathLinkHyperlinks(): void {
	const state = readState();
	if (!state.applied) writeState({ applied: true, previous: readHyperlinksSetting() });
	writeHyperlinksSetting(true);
	setCapabilityOverrides({ ...overridesFromSettings(), hyperlinks: true });
}

/** Restore the snapshotted hyperlinks setting and drop the capability override. */
export function disablePathLinkHyperlinks(): void {
	const state = readState();
	if (state.applied) writeHyperlinksSetting(state.previous);
	rmSync(statePath(), { force: true });
	setCapabilityOverrides(overridesFromSettings());
}
