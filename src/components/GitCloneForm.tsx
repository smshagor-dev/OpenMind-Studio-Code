import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import "../styles/sourceControl.css";

function useClone() {
  useSyncExternalStore(
    (listener) => container.gitClone.subscribe(listener),
    () => container.gitClone.getState(),
  );
  // The Git that may be used changes with the Source Control snapshot.
  useSyncExternalStore(
    (listener) => container.sourceControl.subscribe(listener),
    () => container.sourceControl.getState(),
  );
  return container.gitClone;
}

/**
 * "Clone Repository": a button that opens an inline form — address, destination
 * folder (chosen with the folder dialog), folder name — and a Clone button that
 * says why it is disabled. A destination that isn't empty is refused with
 * Git's / OpenMind's message and never overwritten. UI only.
 */
export function GitCloneForm() {
  const clone = useClone();
  const state = clone.getState();
  const entry = clone.entryState();
  const action = clone.cloneState();
  return (
    <div className="git-clone">
      <button
        type="button"
        className="git-button"
        disabled={!entry.enabled}
        title={entry.enabled ? "Clone a repository from an address" : entry.reason}
        aria-expanded={state.formOpen}
        onClick={() => {
          clone.toggleForm();
        }}
      >
        Clone Repository
      </button>
      {!entry.enabled ? (
        <p className="git-commit__reason" role="note">
          {entry.reason}
        </p>
      ) : null}
      {state.formOpen && entry.enabled ? (
        <form
          className="git-clone__form"
          aria-label="Clone Repository"
          onSubmit={(event) => {
            event.preventDefault();
            void clone.clone();
          }}
        >
          <label className="git-clone__label" htmlFor="git-clone-url">
            Repository address
          </label>
          <input
            id="git-clone-url"
            className="git-input"
            placeholder="https://host/owner/repo.git or a local path"
            value={state.url}
            onChange={(event) => {
              clone.setUrl(event.target.value);
            }}
          />
          <span className="git-clone__label">Destination folder</span>
          <div className="git-clone__row">
            <code className="git-clone__path" title={state.parent ?? undefined}>
              {state.parent ?? "No folder chosen"}
            </code>
            <button type="button" className="git-button" onClick={() => void clone.chooseFolder()}>
              Choose Folder…
            </button>
          </div>
          <label className="git-clone__label" htmlFor="git-clone-name">
            Folder name
          </label>
          <input
            id="git-clone-name"
            className="git-input"
            value={clone.name()}
            onChange={(event) => {
              clone.setName(event.target.value);
            }}
          />
          <button
            type="submit"
            className="git-button git-button--primary"
            disabled={!action.enabled}
            title={action.enabled ? "Clone into the folder" : action.reason}
          >
            {state.busy ? "Cloning…" : "Clone"}
          </button>
          {!action.enabled ? (
            <p className="git-commit__reason" role="note">
              {action.reason}
            </p>
          ) : null}
          {state.error ? (
            <p className="git-message git-message--error" role="alert">
              {state.error}
            </p>
          ) : null}
          {state.cloned ? (
            <div className="git-clone__done" role="status">
              <p className="git-message">Cloned to {state.cloned}</p>
              <button
                type="button"
                className="git-button git-button--primary"
                onClick={() => void clone.openCloned()}
              >
                Open Cloned Folder
              </button>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
