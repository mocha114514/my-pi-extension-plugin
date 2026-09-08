export type Locale = "zh-CN" | "en";
export type LanguageMode = "auto" | Locale;

export function isLanguageMode(value: unknown): value is LanguageMode {
  return value === "auto" || value === "zh-CN" || value === "en";
}

function normalizeLocale(value: string): Locale {
  return /^zh(?:[-_.@]|$)/i.test(value.trim()) ? "zh-CN" : "en";
}

/** Explicit terminal preferences win; Intl is the cross-platform OS fallback. */
export function detectLocale(env: NodeJS.ProcessEnv, systemLocale: string): Locale {
  const terminalLocale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find(value => value?.trim());
  // C/POSIX explicitly requests the neutral (English) locale, even with LANGUAGE set.
  if (terminalLocale && /^(C|POSIX)([.@]|$)/i.test(terminalLocale.trim())) return "en";
  const preference = env.LANGUAGE?.split(":").find(value => value.trim());
  return normalizeLocale(preference ?? terminalLocale ?? systemLocale);
}

export function resolveLocale(mode: LanguageMode, env: NodeJS.ProcessEnv, systemLocale: string): Locale {
  return mode === "auto" ? detectLocale(env, systemLocale) : mode;
}
