import { useSyncExternalStore } from "react";

import "../styles/deps.css";
import { useT } from "../i18n";
import { container } from "../services/container";
import { serverLanguage } from "../services/languageTools/languageToolsModel";

/**
 * "Fortran language support is incomplete because fortls is not installed. [Install now] [Dismiss]" — bottom right, for
 * the file in front. Install starts at once (no other dialog); a failure is reported by the usual error toast. A card
 * explaining a failure that just happened (a missing package, the network) or a project setup hint goes first.
 */
export function LanguageToolsPromptCard() {
  const t = useT();
  const prompt = container.languageTools;
  const state = useSyncExternalStore(prompt.subscribe, prompt.getState);
  const helper = useSyncExternalStore(container.deps.subscribe, container.deps.getState);
  const network = useSyncExternalStore(container.network.subscribe, container.network.getState);
  useSyncExternalStore(container.dependencies.subscribe, container.dependencies.getState);
  const server = prompt.server();
  if (server === null || helper.issue !== null || network.failure !== null) return null;
  if (container.dependencies.pendingHint() !== null) return null;
  return (
    <div className="dependency-card" role="status" aria-label={t("languageTools.prompt.label")}>
      <p className="dependency-card__text">
        {t("languageTools.prompt.text", { language: serverLanguage(server), name: server.name })}
      </p>
      <p className="dependency-card__hint">
        {state.installing ? t("languageTools.prompt.installing", { name: server.name }) : t("languageTools.prompt.hint")}
      </p>
      <div className="dependency-card__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={state.installing}
          onClick={() => void prompt.install()}
        >
          {state.installing ? t("languageTools.installing") : t("languageTools.prompt.install")}
        </button>
        <button
          type="button"
          disabled={state.installing}
          onClick={() => {
            prompt.dismiss();
          }}
        >
          {t("common.dismissAction")}
        </button>
      </div>
    </div>
  );
}
