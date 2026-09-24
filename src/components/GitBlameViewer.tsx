import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import { formatBlameTime } from "../services/gitBlameService";
import "../styles/sourceControl.css";

/**
 * Blame over the editor area: every line of the active file with the commit,
 * author, date and summary that last changed it. It is a read-only overlay —
 * the file itself is never touched — and it shows the saved version on disk. A
 * file Git can't blame (untracked, binary, too large) shows the reason instead.
 * UI only.
 */
export function GitBlameViewer() {
  const view = useSyncExternalStore(
    (listener) => container.gitBlame.subscribe(listener),
    () => container.gitBlame.getView(),
  );
  if (view === null) return null;
  return (
    <section className="git-blame" aria-label="Git blame">
      <header className="git-diff__header">
        <span className="git-diff__title">{view.path} (Blame — saved version)</span>
        <button
          type="button"
          className="git-diff__close"
          aria-label="Close blame"
          title="Close blame"
          onClick={() => {
            container.gitBlame.close();
          }}
        >
          ×
        </button>
      </header>
      {view.loading ? <p className="git-diff__message">Reading blame…</p> : null}
      {view.error ? (
        <p className="git-diff__message git-diff__message--error" role="alert">
          {view.error}
        </p>
      ) : null}
      {view.lines.length > 0 ? (
        <div className="git-blame__scroll">
          <table className="git-blame__table">
            <tbody>
              {view.lines.map((line) => (
                <tr
                  key={line.line}
                  className={line.committed ? undefined : "git-blame__row--uncommitted"}
                >
                  <td className="git-blame__num">{line.line}</td>
                  <td className="git-blame__hash" title={line.summary}>
                    {line.committed ? line.shortHash : "—"}
                  </td>
                  <td className="git-blame__author">{line.author}</td>
                  <td className="git-blame__date">{formatBlameTime(line.time)}</td>
                  <td className="git-blame__summary" title={line.summary}>
                    {line.summary}
                  </td>
                  <td className="git-blame__code">{line.content}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
