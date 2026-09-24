import { useSyncExternalStore } from "react";

import { MonacoDiffHost } from "../editor/MonacoDiffHost";
import { container } from "../services/container";
import { diffTitle } from "../services/sourceControlService";
import "../styles/sourceControl.css";

const THEMES: Record<string, string> = { dark: "vs-dark", light: "vs" };

/**
 * The Git diff over the editor area: the original on the left and the
 * modified text on the right for the working-tree or the staged version of one
 * file. Added and deleted files show an empty side; binary and too-large files
 * show a plain message instead. UI only — `SourceControlService` loads it.
 */
export function GitDiffViewer({ themeKind }: { themeKind: string }) {
  const diff = useSyncExternalStore(
    (listener) => container.sourceControl.subscribe(listener),
    () => container.sourceControl.getState().diff,
  );
  if (diff === null) return null;
  const sides = diff.sides;
  return (
    <section className="git-diff" aria-label="Git diff">
      <header className="git-diff__header">
        <span className="git-diff__title">{diffTitle(diff.path, diff.staged)}</span>
        <button
          type="button"
          className="git-diff__close"
          aria-label="Close diff"
          title="Close diff"
          onClick={() => {
            container.sourceControl.closeDiff();
          }}
        >
          ×
        </button>
      </header>
      {diff.loading ? <p className="git-diff__message">Loading diff…</p> : null}
      {diff.error ? (
        <p className="git-diff__message git-diff__message--error" role="alert">
          {diff.error}
        </p>
      ) : null}
      {sides?.binary ? (
        <p className="git-diff__message">Binary file diff is not supported.</p>
      ) : null}
      {sides && !sides.binary ? (
        <>
          {sides.original === null ? (
            <p className="git-diff__note">New file — nothing on the left.</p>
          ) : null}
          {sides.modified === null ? (
            <p className="git-diff__note">Deleted file — nothing on the right.</p>
          ) : null}
          <MonacoDiffHost
            original={sides.original}
            modified={sides.modified}
            path={sides.path}
            theme={THEMES[themeKind] ?? "vs-dark"}
          />
        </>
      ) : null}
    </section>
  );
}
