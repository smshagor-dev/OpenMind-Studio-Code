import { useEffect, useSyncExternalStore } from "react";

import { container } from "../services/container";
import { stashTitle } from "../services/gitStashService";
import "../styles/sourceControl.css";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Stashes: a box to stash the current changes (message, "Include untracked
 * files"), and the list with Apply, Pop and Drop for each. Drop asks first; a
 * conflicting Apply/Pop shows Git's message and leaves the conflict alone. UI only.
 */
export function GitStashPanel() {
  const stash = container.gitStash;
  const state = useSyncExternalStore(
    (listener) => stash.subscribe(listener),
    () => stash.getState(),
  );
  useSyncExternalStore(
    (listener) => container.sourceControl.subscribe(listener),
    () => container.sourceControl.getState(),
  );
  useEffect(() => {
    void stash.load();
  }, [stash]);
  const stashAction = stash.stashState();
  const entry = stash.entryState();

  return (
    <section className="git-stashes" aria-label="Stashes">
      <h4 className="git-group__heading">
        Stashes <span className="git-group__count">{state.stashes.length}</span>
      </h4>
      <form
        className="git-stashes__form"
        onSubmit={(event) => {
          event.preventDefault();
          void stash.stash();
        }}
      >
        <input
          className="git-input"
          aria-label="Stash message"
          placeholder="Stash message (optional)"
          value={state.message}
          onChange={(event) => {
            stash.setMessage(event.target.value);
          }}
        />
        <label className="git-stashes__check">
          <input
            type="checkbox"
            checked={state.includeUntracked}
            onChange={(event) => {
              stash.setIncludeUntracked(event.target.checked);
            }}
          />
          Include untracked files
        </label>
        <button
          type="submit"
          className="git-button"
          disabled={!stashAction.enabled}
          title={stashAction.enabled ? "Stash the current changes" : stashAction.reason}
        >
          Stash Changes
        </button>
      </form>
      {state.busy ? (
        <p className="git-message" role="status">
          {state.busy}…
        </p>
      ) : null}
      {state.error ? (
        <p className="git-message git-message--error" role="alert">
          {state.error}
        </p>
      ) : null}
      {!state.error && state.notice ? (
        <p className="git-message" role="status">
          {state.notice}
        </p>
      ) : null}
      {state.loaded && state.stashes.length === 0 ? (
        <p className="git-message">There are no stashes.</p>
      ) : null}
      <ul className="git-group__list">
        {state.stashes.map((item) => (
          <li key={item.index} className="git-stash">
            <span className="git-stash__title" title={item.description}>
              {stashTitle(item)}
              {item.branch ? <span className="git-row__folder"> on {item.branch}</span> : null}
            </span>
            <span className="git-stash__actions">
              <button
                type="button"
                className="git-row__action"
                aria-label={`Apply stash ${stashTitle(item)}`}
                disabled={!entry.enabled}
                title={entry.enabled ? "Apply and keep the stash" : entry.reason}
                onClick={() => void stash.apply(item.index)}
              >
                Apply
              </button>
              <button
                type="button"
                className="git-row__action"
                aria-label={`Pop stash ${stashTitle(item)}`}
                disabled={!entry.enabled}
                title={entry.enabled ? "Apply and remove the stash" : entry.reason}
                onClick={() => void stash.pop(item.index)}
              >
                Pop
              </button>
              <button
                type="button"
                className="git-row__action"
                aria-label={`Drop stash ${stashTitle(item)}`}
                disabled={!entry.enabled}
                title={entry.enabled ? "Delete the stash" : entry.reason}
                onClick={() => {
                  stash.requestDrop(item);
                }}
              >
                Drop
              </button>
            </span>
          </li>
        ))}
      </ul>
      {state.pendingDrop ? (
        <ConfirmDialog
          title="Drop Stash"
          message={`Delete the stash "${stashTitle(state.pendingDrop)}"? Its changes can't be recovered afterwards.`}
          confirmLabel="Drop Stash"
          onConfirm={() => void stash.confirmDrop()}
          onCancel={() => {
            stash.cancelDrop();
          }}
        />
      ) : null}
    </section>
  );
}
