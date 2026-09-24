import { useEffect, useSyncExternalStore } from "react";

import { container } from "../services/container";
import { commitFileWord, formatCommitDate } from "../services/gitHistoryService";
import "../styles/sourceControl.css";

/**
 * History: the latest commits of the current branch (short hash, subject,
 * author, date), newest first — no graph. Selecting a commit lists the files it
 * changed; a file opens its diff for that commit. It reloads whenever HEAD
 * moves (a commit, a switch). UI only.
 */
export function GitHistoryPanel() {
  const history = container.gitHistory;
  const state = useSyncExternalStore(
    (listener) => history.subscribe(listener),
    () => history.getState(),
  );
  useSyncExternalStore(
    (listener) => container.sourceControl.subscribe(listener),
    () => container.sourceControl.getState(),
  );
  const head = container.sourceControl.status()?.oid ?? null;
  useEffect(() => {
    void history.load();
  }, [history, head]);

  return (
    <section className="git-history" aria-label="History">
      <h4 className="git-group__heading">
        History <span className="git-group__count">{state.commits.length}</span>
      </h4>
      {state.loading && !state.loaded ? <p className="git-message">Loading history…</p> : null}
      {state.error ? (
        <p className="git-message git-message--error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.loaded && state.commits.length === 0 ? (
        <p className="git-message">There are no commits yet.</p>
      ) : null}
      <ul className="git-group__list">
        {state.commits.map((commit) => (
          <li key={commit.hash}>
            <button
              type="button"
              className={
                state.selected === commit.hash
                  ? "git-commit-row git-commit-row--selected"
                  : "git-commit-row"
              }
              aria-expanded={state.selected === commit.hash}
              title={`${commit.hash}\n${commit.author}\n${formatCommitDate(commit.date)}`}
              onClick={() => void history.select(commit.hash)}
            >
              <span className="git-commit-row__hash">{commit.shortHash}</span>
              <span className="git-commit-row__subject">{commit.subject || "(no message)"}</span>
              <span className="git-row__folder">
                {commit.author} · {formatCommitDate(commit.date)}
              </span>
            </button>
            {state.selected === commit.hash ? (
              <ul className="git-commit-files" aria-label={`Files in ${commit.shortHash}`}>
                {state.filesLoading ? <li className="git-message">Loading files…</li> : null}
                {state.files.map((file) => (
                  <li key={`${file.status}:${file.path}`}>
                    <button
                      type="button"
                      className="git-row__main"
                      title={`${commitFileWord(file.status)}${file.origPath ? ` (from ${file.origPath})` : ""}`}
                      onClick={() => void history.openFile(file)}
                    >
                      <span className="git-row__badge" data-kind={commitFileWord(file.status)}>
                        {file.status}
                      </span>
                      <span className="git-row__name">{file.path}</span>
                      {file.origPath ? (
                        <span className="git-row__folder">← {file.origPath}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
                {!state.filesLoading && state.files.length === 0 ? (
                  <li className="git-message">This commit changed no files.</li>
                ) : null}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
