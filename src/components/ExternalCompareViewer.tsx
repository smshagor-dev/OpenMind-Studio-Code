import { useSyncExternalStore } from "react";

import { MonacoDiffHost } from "../editor/MonacoDiffHost";
import { container } from "../services/container";
import "../styles/externalSync.css";
import { MONACO_THEME_MAP } from "../editor/monacoThemes";

/**
 * "Compare" for a file that changed on disk while it has unsaved edits: the
 * disk version on the left, the editor's text (with the edits) on the right,
 * read-only, over the editor area. UI only.
 */
export function ExternalCompareViewer({ themeKind }: { themeKind: string }) {
  const compare = useSyncExternalStore(
    (listener) => container.fileSync.subscribe(listener),
    () => container.fileSync.getState().compare,
  );
  if (compare === null) return null;
  return (
    <section className="ext-compare" aria-label="Compare with disk">
      <header className="git-diff__header">
        <span className="git-diff__title">
          {compare.title} — On disk (left) · Your changes (right)
        </span>
        <button
          type="button"
          className="git-diff__close"
          aria-label="Close compare"
          title="Close compare"
          onClick={() => {
            container.fileSync.closeCompare();
          }}
        >
          ×
        </button>
      </header>
      <MonacoDiffHost
        original={compare.disk}
        modified={compare.buffer}
        path={compare.title}
        theme={MONACO_THEME_MAP[themeKind] ?? "openmind-dark"}
      />
    </section>
  );
}
