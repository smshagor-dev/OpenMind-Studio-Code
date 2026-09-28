import { useEffect, useState } from "react";

import { t, useT } from "../i18n";
import { failureText } from "./failureText";
import { messageOf, type StartupErrorApi, type StartupFailure } from "./startupErrorApi";
import "../styles/startupError.css";

type Load =
  | { state: "loading" }
  | { state: "ready"; failure: StartupFailure }
  | { state: "failed"; error: string };

/**
 * Shown instead of the workbench when the local database can't be opened. Only plain text is rendered; every action
 * is a click, and the database is changed only by Back Up and Start Fresh after its own confirmation. The text is in
 * the UI language (by the failure's stable kind); the copied details stay in English, for reports.
 */
export function StartupErrorPage({ api }: { api: StartupErrorApi }) {
  useT();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    api.info().then(
      (failure) => {
        setLoad({ state: "ready", failure });
      },
      (error: unknown) => {
        setLoad({ state: "failed", error: messageOf(error) });
      },
    );
  }, [api]);

  const act = (action: () => Promise<void>, done: string | null, failed: string) => {
    action().then(
      () => {
        setStatus(done);
      },
      (error: unknown) => {
        setStatus(t("databaseError.actionFailed", { action: failed, error: messageOf(error) }));
      },
    );
  };
  const exit = () => {
    act(() => api.exit(), null, t("databaseError.exitFailed"));
  };

  return (
    <main className="startup-error">
      <h1 className="startup-error__heading">{t("databaseError.heading")}</h1>
      {load.state === "loading" && (
        <p className="startup-error__muted">{t("databaseError.reading")}</p>
      )}
      {load.state === "failed" && (
        <>
          <p>{t("databaseError.unreadable", { error: load.error })}</p>
          <p>{t("databaseError.notDeleted")}</p>
          <div className="startup-error__actions">
            <button type="button" onClick={exit}>
              {t("databaseError.exit")}
            </button>
          </div>
        </>
      )}
      {load.state === "ready" && (
        <>
          <Summary failure={load.failure} />
          <div className="startup-error__actions">
            <button
              type="button"
              onClick={() => {
                act(
                  () => api.openDataFolder(),
                  t("databaseError.openedFolder"),
                  t("databaseError.openFolderFailed"),
                );
              }}
            >
              {t("databaseError.openDataFolder")}
            </button>
            <button
              type="button"
              onClick={() => {
                act(
                  () => api.copy(load.failure.details),
                  t("databaseError.copied"),
                  t("databaseError.copyFailed"),
                );
              }}
            >
              {t("databaseError.copyDetails")}
            </button>
            <button type="button" className="startup-error__primary" onClick={exit}>
              {t("databaseError.exit")}
            </button>
          </div>
          <BackUp api={api} failure={load.failure} />
        </>
      )}
      <p className="startup-error__status" role="status">
        {status}
      </p>
    </main>
  );
}

function Summary({ failure }: { failure: StartupFailure }) {
  const text = failureText(failure);
  return (
    <>
      <h2 className="startup-error__title">{text.title}</h2>
      <p>{text.explanation}</p>
      <dl className="startup-error__facts">
        <dt>{t("databaseError.category")}</dt>
        <dd>{text.category}</dd>
        <dt>{t("databaseError.database")}</dt>
        <dd className="startup-error__path">{failure.dbPath}</dd>
      </dl>
      <h3>{t("databaseError.whatYouCanDo")}</h3>
      <ul>
        {text.nextSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>
      <details className="startup-error__details">
        <summary>{t("databaseError.details")}</summary>
        <pre>{failure.details}</pre>
      </details>
    </>
  );
}

type BackUpState =
  | { step: "idle" }
  | { step: "confirm" }
  | { step: "moved"; folder: string }
  | { step: "failed"; error: string };

/** "Back Up and Start Fresh": asks first, moves the files, then offers a restart. Never automatic. */
function BackUp({ api, failure }: { api: StartupErrorApi; failure: StartupFailure }) {
  const [state, setState] = useState<BackUpState>({ step: "idle" });
  if (!failure.canBackUp) return null;
  if (state.step === "idle")
    return (
      <div className="startup-error__backup">
        <button
          type="button"
          onClick={() => {
            setState({ step: "confirm" });
          }}
        >
          {t("databaseError.backUp")}
        </button>
      </div>
    );
  if (state.step === "moved")
    return (
      <div className="startup-error__backup">
        <p>{t("databaseError.moved", { folder: state.folder })}</p>
        <button type="button" className="startup-error__primary" onClick={() => void api.restart()}>
          {t("databaseError.restart")}
        </button>
      </div>
    );
  return (
    <div className="startup-error__backup" role="group" aria-label={t("databaseError.backUpGroup")}>
      <p>{t("databaseError.backUpExplained", { folder: failure.dataDir })}</p>
      {state.step === "failed" && (
        <p className="startup-error__problem">
          {t("databaseError.nothingMoved", { error: state.error })}
        </p>
      )}
      <button
        type="button"
        className="startup-error__danger"
        onClick={() => {
          api.backUp().then(
            (folder) => {
              setState({ step: "moved", folder });
            },
            (error: unknown) => {
              setState({ step: "failed", error: messageOf(error) });
            },
          );
        }}
      >
        {t("databaseError.moveAndContinue")}
      </button>
      <button
        type="button"
        onClick={() => {
          setState({ step: "idle" });
        }}
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}
