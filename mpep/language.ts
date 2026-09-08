import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLanguageMode, reloadLanguageSettings, setLanguageMode, t, type LanguageMode } from "./shared/i18n/index.ts";

export default function languageExtension(pi: ExtensionAPI) {
  reloadLanguageSettings();
  pi.registerCommand("m-lgg", {
    description: t("language.description"),
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify(t("language.requiresUI"), "warning"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify(t("language.busy"), "warning"); return; }
      const { error } = reloadLanguageSettings();
      if (error) { ctx.ui.notify(t("language.readFailed"), "error"); return; }
      const current = getLanguageMode();
      // Autonyms remain recognizable even when the current UI language is unfamiliar.
      const options: { mode: LanguageMode; label: string }[] = [
        { mode: "auto", label: t("language.auto") },
        { mode: "zh-CN", label: "简体中文" },
        { mode: "en", label: "English" },
      ];
      const choices = options.map(option => ({ ...option, label: `${option.mode === current ? "[x]" : "[ ]"} ${option.label}` }));
      const selected = await ctx.ui.select(t("language.title"), choices.map(option => option.label));
      const choice = choices.find(option => option.label === selected);
      if (!choice || choice.mode === current) return;
      if (!ctx.isIdle()) { ctx.ui.notify(t("language.busy"), "warning"); return; }
      try { setLanguageMode(choice.mode); }
      catch { ctx.ui.notify(t("language.saveFailed"), "error"); return; }
      try { await ctx.reload(); }
      catch { ctx.ui.notify(t("language.reloadFailed"), "error"); }
    },
  });
}
