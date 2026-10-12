import { useSyncExternalStore } from "react";

import { t, useT } from "../../i18n";
import { updates } from "../../services/updates";
import { percent, restartBlocker } from "../../services/updates/updateModel";
import type { UpdateInfo } from "../../services/updates/updateIpc";

function Summary({ info }: { info: UpdateInfo }) {
  const version = info.version ?? "";
  if (info.phase === "checking") return <p>{t("update.dialog.checking")}</p>;
  if (info.mode.kind === "managed" && info.available) {
    return (
      <>
        <p>{t("update.dialog.new", { version })}</p>
        <p className="update-dialog__muted">{info.mode.reason}</p>
      </>
    );
  }
  if (info.ready) {
    return (
      <>
        <p>{t("update.dialog.readyText", { version })}</p>
        {info.mode.kind === "portable" && <p className="update-dialog__muted">{t("update.dialog.portableText")}</p>}
        <p className="update-dialog__muted">{t("update.dialog.verified")}</p>
      </>
    );
  }
  if (info.phase === "downloading") {
    const done = percent(info);
    return (
      <>
        <p>{t("update.dialog.new", { version })}</p>
        <progress className="update-dialog__progress" max={100} value={done ?? undefined} />
      </>
    );
  }
  if (info.available) {
    return (
      <>
        <p>{t("update.dialog.new", { version })}</p>
        {!info.automatic && <p className="update-dialog__muted">{t("update.dialog.manualText")}</p>}
      </>
    );
  }
  if (info.phase === "upToDate") return <p>{t("update.dialog.upToDate")}</p>;
  return null;
}

/** Help > Check for Updates, and a click on the status bar item: what is known, with the actions that apply. */
export function UpdateDialog() {
  useT();
  const { info, dialogOpen, busy, error } = useSyncExternalStore(updates.subscribe, updates.getState);
  if (!dialogOpen || info === null) return null;
  const blocker = restartBlocker(info);
  const failure = info.phase === "failed" && info.failure !== null ? info.failure : null;
  return (
    <div className="modal-overlay" onClick={() => { updates.closeDialog(); }}>
      <div
        className="modal update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="update-dialog-title">{t("update.dialog.title")}</h2>
        <p className="update-dialog__muted">{t("update.dialog.current", { version: info.current })}</p>
        <Summary info={info} />
        {failure !== null && (
          <p className="update-dialog__error" role="alert" title={failure.message}>
            {t(`update.failure.${failure.kind}`)}
          </p>
        )}
        {error !== null && (
          <p className="update-dialog__error" role="alert">
            {error}
          </p>
        )}
        {info.notes && info.available && (
          <details className="update-dialog__notes">
            <summary>{t("update.dialog.notes")}</summary>
            <pre>{info.notes}</pre>
          </details>
        )}
        {info.ready && (
          <label className="update-dialog__check">
            <input
              type="checkbox"
              checked={info.installOnExit}
              disabled={busy}
              onChange={(event) => {
                void updates.setInstallOnExit(event.target.checked);
              }}
            />
            {t("update.dialog.installOnExit")}
          </label>
        )}
        {info.lastChecked !== null && (
          <p className="update-dialog__muted">{t("update.dialog.lastChecked", { time: info.lastChecked })}</p>
        )}
        <div className="update-dialog__actions">
          {info.activity.unsaved > 0 && info.ready && (
            <button type="button" disabled={busy} onClick={() => void updates.saveAll()}>
              {t("update.action.saveAll")}
            </button>
          )}
          {info.ready && (
            <button
              type="button"
              className="update-dialog__primary"
              disabled={busy || blocker !== null}
              title={blocker === null ? undefined : t(blocker.key, blocker.params)}
              onClick={() => void updates.restartToUpdate()}
            >
              {t("update.action.restart")}
            </button>
          )}
          {info.available && !info.ready && info.phase !== "downloading" && info.mode.kind !== "managed" && (
            <button type="button" disabled={busy} onClick={() => void updates.download()}>
              {t("update.action.download")}
            </button>
          )}
          {!info.ready && (
            <button
              type="button"
              disabled={busy || info.phase === "checking" || info.phase === "downloading"}
              onClick={() => void updates.checkNow()}
            >
              {t("update.action.check")}
            </button>
          )}
          <button type="button" onClick={() => void updates.openReleasesPage()}>
            {t("update.action.releases")}
          </button>
          <button type="button" onClick={() => { updates.closeDialog(); }}>
            {t("update.action.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
