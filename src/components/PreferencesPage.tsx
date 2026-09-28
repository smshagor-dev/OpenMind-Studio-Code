import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { PreferencesTab } from "../services/preferencesPageService";
import "../styles/preferences.css";
import { KeybindingsTab } from "./KeybindingsTab";
import { SettingsTab } from "./SettingsTab";
import { t } from "../i18n";

const TABS: { id: PreferencesTab; label: string }[] = [
  { id: "settings", label: "preferences.tab.settings" },
  { id: "keybindings", label: "preferences.tab.keybindings" },
];

/** The Settings / Keyboard Shortcuts page over the editor area. UI only: the services own every value. */
export function PreferencesPage() {
  const page = useSyncExternalStore(
    (listener) => container.preferencesPage.subscribe(listener),
    () => container.preferencesPage.getState(),
  );
  if (!page.open) return null;
  return (
    <section className="prefs" aria-label={t("preferences.region")}>
      <header className="prefs-header">
        <div className="prefs-tabs" role="tablist" aria-label={t("preferences.tabs")}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={page.tab === tab.id}
              className={page.tab === tab.id ? "prefs-tab prefs-tab--active" : "prefs-tab"}
              onClick={() => {
                container.preferencesPage.setTab(tab.id);
              }}
            >
              {t(tab.label)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="prefs-close"
          aria-label={t("preferences.close")}
          title={t("common.close")}
          onClick={() => {
            container.preferencesPage.close();
          }}
        >
          ×
        </button>
      </header>
      {page.tab === "settings" ? <SettingsTab /> : <KeybindingsTab />}
    </section>
  );
}
