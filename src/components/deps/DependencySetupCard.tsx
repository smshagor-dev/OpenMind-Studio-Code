import { useSyncExternalStore } from "react";

import "../../styles/deps.css";
import { useT } from "../../i18n";
import { container } from "../../services/container";

/**
 * A project's incomplete setup ("Python project detected. No project environment exists."), offered once: the action
 * goes through the usual confirmation, and "Not Now" is remembered for that project. Nothing happens by itself.
 */
export function DependencySetupCard() {
  const t = useT();
  const state = useSyncExternalStore(container.dependencies.subscribe, container.dependencies.getState);
  const helper = useSyncExternalStore(container.deps.subscribe, container.deps.getState);
  const network = useSyncExternalStore(container.network.subscribe, container.network.getState);
  const hint = container.dependencies.pendingHint();
  // A missing-package or network card explains a failure that just happened: it goes first.
  if (hint === null || helper.issue !== null || network.failure !== null) return null;
  const { project, kind } = hint;
  return (
    <div className="dependency-card" role="status" aria-label={t("deps.setup.title")}>
      <p className="dependency-card__text">{t(`deps.setup.${kind}`, { project: project.name })}</p>
      <div className="dependency-card__actions">
        <button type="button" disabled={state.busy} onClick={() => void container.dependencies.acceptHint(project, kind)}>
          {t(`deps.setup.${kind}.action`)}
        </button>
        <button type="button" onClick={() => void container.dependencies.dismissHint(project, kind)}>
          {t("deps.setup.notNow")}
        </button>
      </div>
    </div>
  );
}
