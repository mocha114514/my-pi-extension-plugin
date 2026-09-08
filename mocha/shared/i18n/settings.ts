import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isLanguageMode, type LanguageMode } from "./detect.ts";

export class LanguageSettingsError extends Error {
  readonly reason: "read" | "format" | "write";
  constructor(reason: "read" | "format" | "write", options?: ErrorOptions) {
    super(`Language settings: ${reason}`, options);
    this.reason = reason;
  }
}

function readSettings(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new LanguageSettingsError("read", { cause: error });
  }
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
    const settings = value as Record<string, unknown>;
    if (settings.language !== undefined && !isLanguageMode(settings.language)) throw new Error("Invalid language");
    return settings;
  } catch (error) {
    throw new LanguageSettingsError("format", { cause: error });
  }
}

export function readLanguageMode(path: string): LanguageMode {
  return (readSettings(path).language as LanguageMode | undefined) ?? "auto";
}

/** Re-read before writing so other Mocha preferences survive a language change. */
export function writeLanguageMode(path: string, mode: LanguageMode): void {
  if (!isLanguageMode(mode)) throw new LanguageSettingsError("format");
  const settings = readSettings(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ ...settings, language: mode }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    throw new LanguageSettingsError("write", { cause: error });
  } finally {
    rmSync(temporary, { force: true });
  }
}
