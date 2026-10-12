import { useSyncExternalStore } from "react";

import { t, useT } from "../../i18n";
import { updates } from "../../services/updates";
import { mandatoryBlocks, restartBlocker } from "../../services/updates/updateModel";

/**
 * A mandatory update (the release's minimum version is newer than this one) that is downloaded, verified and installable
 * here: work stops behind this until Restart to Update — after Save All when editors are unsaved, never discarding them.
 * If installing fails (permissions, policy), the reason is shown and Continue for Now keeps the app usable: nobody is
 * ever locked out by an update that can't be installed.
 */
export function MandatoryUpdateOverlay() {
  useT();
  const { info, continuedAfterFailure, busy, error } = useSyncExternalStore(updates.subscribe, updates.getState);
  if (info === null || !mandatoryBlocks(info, continuedAfterFailure)) return null;
  const blocker = restartBlocker(info);
  const failed = error !== null || (info.phase === "failed" && info.failure !== null);
  return (
    <div className="modal-overlay update-mandatory" role="presentation">
      <div className="modal update-dialog" role="alertdialog" aria-modal="true" aria-labelledby="update-mandatory-title">
        <h2 id="update-mandatory-title">{t("update.mandatory.title")}</h2>
        <p>{t("update.mandatory.text", { current: info.current, version: info.version ?? "" })}</p>
        {blocker !== null && <p className="update-dialog__muted">{t(blocker.key, blocker.params)}</p>}
        {failed && (
          <p className="update-dialog__error" role="alert">
            {t("update.mandatory.failed", { reason: error ?? info.failure?.message ?? "" })}
          </p>
        )}
        <div className="update-dialog__actions">
          {info.activity.unsaved > 0 && (
            <button type="button" disabled={busy} onClick={() => void updates.saveAll()}>
              {t("update.action.saveAll")}
            </button>
          )}
          <button
            type="button"
            className="update-dialog__primary"
            disabled={busy || blocker !== null}
            onClick={() => void updates.restartToUpdate()}
          >
            {t("update.action.restart")}
          </button>
          {failed && (
            <button type="button" onClick={() => { updates.continueAfterFailure(); }}>
              {t("update.action.continue")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
