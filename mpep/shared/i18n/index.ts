import { join } from "node:path";
import { getCacheDir } from "../paths.ts";
import { resolveLocale, type LanguageMode, type Locale } from "./detect.ts";
import { en } from "./locales/en.ts";
import { zhCN } from "./locales/zh-CN.ts";
import { readLanguageMode, writeLanguageMode } from "./settings.ts";

export type MessageKey = keyof typeof en;
export type { LanguageMode, Locale } from "./detect.ts";
type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never;
type Arguments<K extends MessageKey> = [Placeholders<(typeof en)[K]>] extends [never]
  ? [] : [values: Record<Placeholders<(typeof en)[K]>, string | number>];
interface LanguageState { path: string; mode: LanguageMode; locale: Locale; error?: unknown }

// Pi can evaluate a shared import once per extension. The symbol keeps those copies
// synchronized, while reloadLanguageSettings refreshes preferences on /reload.
const stateKey = Symbol.for("mpep.i18n.state.v1");
const shared = globalThis as typeof globalThis & { [stateKey]?: LanguageState };
const settingsPath = () => join(getCacheDir(), "settings.json");
const resolve = (mode: LanguageMode) => resolveLocale(mode, process.env, Intl.DateTimeFormat().resolvedOptions().locale);

export function reloadLanguageSettings(): LanguageState {
  const path = settingsPath();
  let mode: LanguageMode = "auto", error: unknown;
  try { mode = readLanguageMode(path); } catch (cause) { error = cause; }
  return shared[stateKey] = { path, mode, locale: resolve(mode), error };
}

function state(): LanguageState {
  return shared[stateKey]?.path === settingsPath() ? shared[stateKey]! : reloadLanguageSettings();
}

export function getLanguageMode(): LanguageMode { return state().mode; }
export function getLocale(): Locale { return state().locale; }

export function setLanguageMode(mode: LanguageMode): void {
  const path = settingsPath();
  writeLanguageMode(path, mode);
  shared[stateKey] = { path, mode, locale: resolve(mode) };
}

export function t<K extends MessageKey>(key: K, ...args: Arguments<K>): string {
  const template = (getLocale() === "zh-CN" ? zhCN : en)[key];
  const values = args[0] as Record<string, string | number> | undefined;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match));
}
