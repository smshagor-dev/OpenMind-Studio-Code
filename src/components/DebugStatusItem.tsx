import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import { runSummary } from "../services/debugModel";
import { t } from "../i18n";

/** The status bar's debug indicator: only while a session exists. */
export function DebugStatusItem() {
  useSyncExternalStore(
    (listener) => container.debug.subscribe(listener),
    () => container.debug.getState(),
  );
  const run = container.debug.getState().run;
  if (run === null || run.state === "terminated") return null;
  return (
    <button
      type="button"
      className="statusbar__item statusbar__item--debug"
      title={`${run.configName} — ${runSummary(run)}`}
      onClick={() => {
        container.run("view.showRun");
      }}
    >
      🐞 {run.state === "stopped"
        ? t("debug.status.paused")
        : run.state === "starting"
          ? t("debug.status.starting")
          : t("debug.status.debugging")}
    </button>
  );
}
