import { LANGUAGE_NAMES, t, type Language } from "../i18n";
import type { ConfirmPrompt } from "./extensionPromptService";
import type { IpcClient } from "./ipc";

/** `editor_settings` key: the UI languages the user chose to keep (comma-separated), so each is asked about once. */
export const ENGLISH_OFFER_KEY = "language.englishOffer.kept";

export const SWITCH_TO_ENGLISH = "Switch to English";

export interface EnglishOfferDeps {
  /** The UI language in use now. */
  language: () => Language;
  ipc: Pick<IpcClient, "settingsGet" | "settingsSet">;
  /** The confirmation dialog; resolves with the chosen button, `null` when closed. */
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  /** Writes `workbench.language = "en"` (the UI follows at once); `false` when it couldn't be saved. */
  switchToEnglish: () => Promise<boolean>;
}

export type EnglishOfferResult = "english" | "english-failed" | "kept" | "closed" | "not-needed";

function keptLanguages(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * At start-up, when the UI isn't English (the PC's language or the setting picked Russian): offers to
 * switch to English. The title and buttons are English so the offer can be read either way; the note is in the
 * current language too. "Keep" is remembered per language (no nagging); closing the dialog asks again next launch.
 */
export async function offerEnglish(deps: EnglishOfferDeps): Promise<EnglishOfferResult> {
  const language = deps.language();
  if (language === "en") return "not-needed";
  const kept = keptLanguages(await deps.ipc.settingsGet(ENGLISH_OFFER_KEY).catch(() => null));
  if (kept.includes(language)) return "not-needed";
  const name = LANGUAGE_NAMES[language];
  const keep = `Keep ${name}`;
  const answer = await deps.confirm({
    extension: "OpenMind Studio",
    title: `${SWITCH_TO_ENGLISH}?`,
    details: [{ label: "Current language", value: name }],
    notes: [
      t("language.offer.note", { language: name }),
      "OpenMind Studio is shown in this language because of Windows' language or your setting. You can change it any time in Settings > Language (or File > Preferences > Display Language...).",
    ],
    buttons: [SWITCH_TO_ENGLISH, keep],
  });
  if (answer === SWITCH_TO_ENGLISH) return (await deps.switchToEnglish()) ? "english" : "english-failed";
  if (answer === keep) {
    await deps.ipc.settingsSet(ENGLISH_OFFER_KEY, [...kept, language].join(",")).catch(() => undefined);
    return "kept";
  }
  return "closed";
}
