import { useEffect, useRef, useSyncExternalStore } from "react";

import { MonacoDiffHost } from "../../editor/MonacoDiffHost";
import { MONACO_THEME_MAP } from "../../editor/monacoThemes";
import { t, useT } from "../../i18n";
import { gitViews } from "../../services/editorMenu";
import "../../styles/gitViews.css";
import "../../styles/sourceControl.css";

/**
 * Two versions of a file over the editor area (Open Changes ...): read-only, side by side or inline, scrolled to the
 * line the command was about. UI only — `GitViewsService` holds what is shown.
 */
export function GitCompareView({ themeKind }: { themeKind: string }) {
  useT();
  const compare = useSyncExternalStore(
    (listener) => gitViews.subscribe(listener),
    () => gitViews.getState().compare,
  );
  const sectionRef = useRef<HTMLElement | null>(null);
  const title = compare?.title ?? null;
  // The view takes the keyboard when it opens, so Escape closes it.
  useEffect(() => {
    if (title !== null) sectionRef.current?.focus();
  }, [title]);
  if (compare === null) return null;
  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="file-git-view"
      aria-label={compare.title}
      onKeyDown={(event) => {
        if (event.key === "Escape") gitViews.closeCompare();
      }}
    >
      <header className="file-git-view__header">
        <span className="file-git-view__title" title={compare.title}>
          {compare.title}
        </span>
        <button
          type="button"
          className="file-git-view__button"
          aria-pressed={compare.inline}
          onClick={() => {
            gitViews.toggleCompareInline();
          }}
        >
          {t("gitView.inline")}
        </button>
        <button
          type="button"
          className="file-git-view__close"
          aria-label={t("gitView.close")}
          title={t("gitView.close")}
          onClick={() => {
            gitViews.closeCompare();
          }}
        >
          ×
        </button>
      </header>
      <div className="file-git-view__sides">
        <span title={compare.leftLabel}>
          {compare.original === null
            ? t("gitView.absent", { side: compare.leftLabel })
            : compare.leftLabel}
        </span>
        <span title={compare.rightLabel}>
          {compare.modified === null
            ? t("gitView.absent", { side: compare.rightLabel })
            : compare.rightLabel}
        </span>
      </div>
      <div className="file-git-view__body">
        <MonacoDiffHost
          original={compare.original}
          modified={compare.modified}
          path={compare.path.replace(/\\/g, "/")}
          theme={MONACO_THEME_MAP[themeKind] ?? "openmind-dark"}
          inline={compare.inline}
          revealLine={compare.revealLine}
        />
      </div>
    </section>
  );
}
