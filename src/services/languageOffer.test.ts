import { describe, expect, it, vi } from "vitest";

import type { Language } from "../i18n";
import { ENGLISH_OFFER_KEY, offerEnglish, SWITCH_TO_ENGLISH } from "./languageOffer";

function rig(language: Language, answer: string | null, kept: string | null = null) {
  const store = new Map<string, string>();
  if (kept !== null) store.set(ENGLISH_OFFER_KEY, kept);
  const ipc = {
    settingsGet: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    settingsSet: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  };
  const confirm = vi.fn().mockResolvedValue(answer);
  const switchToEnglish = vi.fn().mockResolvedValue(true);
  return { deps: { language: () => language, ipc, confirm, switchToEnglish }, store, confirm, switchToEnglish };
}

describe("offerEnglish", () => {
  it("never asks when the UI is already English", async () => {
    const r = rig("en", SWITCH_TO_ENGLISH);
    expect(await offerEnglish(r.deps)).toBe("not-needed");
    expect(r.confirm).not.toHaveBeenCalled();
  });

  it("offers English for Russian and switches the setting on request", async () => {
    for (const language of ["ru"] as const) {
      const r = rig(language, SWITCH_TO_ENGLISH);
      expect(await offerEnglish(r.deps)).toBe("english");
      const request = r.confirm.mock.calls[0]?.[0] as { title: string; buttons: string[]; details: { value: string }[] };
      expect(request.title).toBe("Switch to English?");
      expect(request.buttons[0]).toBe("Switch to English");
      expect(request.buttons[1]).toMatch(/^Keep /);
      expect(r.switchToEnglish).toHaveBeenCalledTimes(1);
    }
  });

  it("Keep is remembered per language; closing the dialog asks again next time", async () => {
    const kept = rig("ru", "Keep Русский");
    expect(await offerEnglish(kept.deps)).toBe("kept");
    expect(kept.store.get(ENGLISH_OFFER_KEY)).toBe("ru");
    expect(kept.switchToEnglish).not.toHaveBeenCalled();
    const again = rig("ru", SWITCH_TO_ENGLISH, "ru");
    expect(await offerEnglish(again.deps)).toBe("not-needed");
    expect(again.confirm).not.toHaveBeenCalled();
    // A language kept in an older version (no longer bundled) stays in the list.
    const older = rig("ru", "Keep Русский", "bn");
    expect(await offerEnglish(older.deps)).toBe("kept");
    expect(older.store.get(ENGLISH_OFFER_KEY)).toBe("bn,ru");
    const closed = rig("ru", null);
    expect(await offerEnglish(closed.deps)).toBe("closed");
    expect(closed.store.has(ENGLISH_OFFER_KEY)).toBe(false);
  });

  it("reports when the setting couldn't be saved", async () => {
    const r = rig("ru", SWITCH_TO_ENGLISH);
    r.switchToEnglish.mockResolvedValue(false);
    expect(await offerEnglish(r.deps)).toBe("english-failed");
  });
});
