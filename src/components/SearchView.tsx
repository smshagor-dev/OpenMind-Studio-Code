import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import "../styles/search.css";
import type { SearchTab } from "../services/searchPanelService";
import { FileSearchSection } from "./search/FileSearchSection";
import { IndexBar } from "./search/IndexBar";
import { ReferencesSection } from "./search/ReferencesSection";
import { SymbolSearchSection } from "./search/SymbolSearchSection";
import { TextSearchSection } from "./search/TextSearchSection";
import { t } from "../i18n";

const TABS: { tab: SearchTab; label: string }[] = [
  { tab: "text", label: "search.tab.text" },
  { tab: "files", label: "search.tab.files" },
  { tab: "symbols", label: "search.tab.symbols" },
  { tab: "references", label: "search.tab.references" },
];

/**
 * The Search side bar view: four sections over the workspace — Text (full-text search), Files (by name), Symbols and
 * References — and the state of the background index they are answered from.
 */
export function SearchView() {
  const { tab } = useSyncExternalStore(
    (listener) => container.searchPanel.subscribe(listener),
    () => container.searchPanel.getState(),
  );
  return (
    <div className="search-view">
      <div className="search-tabs" role="tablist" aria-label={t("search.sections")}>
        {TABS.map((entry) => (
          <button
            key={entry.tab}
            type="button"
            role="tab"
            aria-selected={tab === entry.tab}
            className={tab === entry.tab ? "search-tab search-tab--active" : "search-tab"}
            onClick={() => {
              container.searchPanel.setTab(entry.tab);
            }}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>
      <IndexBar />
      {tab === "text" ? <TextSearchSection /> : null}
      {tab === "files" ? <FileSearchSection /> : null}
      {tab === "symbols" ? <SymbolSearchSection /> : null}
      {tab === "references" ? <ReferencesSection /> : null}
    </div>
  );
}
