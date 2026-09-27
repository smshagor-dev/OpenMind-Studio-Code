import { useEffect, useState } from "react";

import { messageOf, type StartupErrorApi, type StartupFailure } from "./startupErrorApi";
import "../styles/startupError.css";

type Load =
  | { state: "loading" }
  | { state: "ready"; failure: StartupFailure }
  | { state: "failed"; error: string };

/**
 * Shown instead of the workbench when the local database can't be opened. Only plain text is rendered; every action
 * is a click, and the database is changed only by Back Up and Start Fresh after its own confirmation.
 */
export function StartupErrorPage({ api }: { api: StartupErrorApi }) {
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
        setStatus(`${failed}: ${messageOf(error)}`);
      },
    );
  };
  const exit = () => {
    act(() => api.exit(), null, "Couldn't exit");
  };

  return (
    <main className="startup-error">
      <h1 className="startup-error__heading">OpenMind Studio couldn't start</h1>
      {load.state === "loading" && <p className="startup-error__muted">Reading the error…</p>}
      {load.state === "failed" && (
        <>
          <p>
            OpenMind Studio couldn't open its local database, and the details couldn't be read
            either: {load.error}
          </p>
          <p>Your data was not deleted.</p>
          <div className="startup-error__actions">
            <button type="button" onClick={exit}>
              Exit
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
                  "Opened the data folder.",
                  "Couldn't open the data folder",
                );
              }}
            >
              Open Data Folder
            </button>
            <button
              type="button"
              onClick={() => {
                act(
                  () => api.copy(load.failure.details),
                  "Error details copied.",
                  "Couldn't copy the details",
                );
              }}
            >
              Copy Error Details
            </button>
            <button type="button" className="startup-error__primary" onClick={exit}>
              Exit
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
  return (
    <>
      <h2 className="startup-error__title">{failure.title}</h2>
      <p>{failure.explanation}</p>
      <dl className="startup-error__facts">
        <dt>Category</dt>
        <dd>{failure.category}</dd>
        <dt>Database</dt>
        <dd className="startup-error__path">{failure.dbPath}</dd>
      </dl>
      <h3>What you can do</h3>
      <ul>
        {failure.nextSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>
      <details className="startup-error__details">
        <summary>Error details</summary>
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
          Back Up and Start Fresh…
        </button>
      </div>
    );
  if (state.step === "moved")
    return (
      <div className="startup-error__backup">
        <p>The database was moved to {state.folder}. Nothing was deleted.</p>
        <button type="button" className="startup-error__primary" onClick={() => void api.restart()}>
          Restart OpenMind Studio
        </button>
      </div>
    );
  return (
    <div className="startup-error__backup" role="group" aria-label="Back up and start fresh">
      <p>
        This moves the database files into a new backup folder inside {failure.dataDir} and starts
        OpenMind Studio with a new, empty database. Recent files, sessions, window sizes, saved AI
        keys and the MariaDB password stay in the backup. Your projects, settings files, runtimes
        and extensions are not touched. Nothing is deleted.
      </p>
      {state.step === "failed" && (
        <p className="startup-error__problem">Nothing was moved: {state.error}</p>
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
        Move the Database and Continue
      </button>
      <button
        type="button"
        onClick={() => {
          setState({ step: "idle" });
        }}
      >
        Cancel
      </button>
    </div>
  );
}
