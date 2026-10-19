import { useSyncExternalStore } from "react";

import "../styles/bookmarks.css";

import { bookmarkRoot, bookmarks, openBookmark } from "../services/bookmarks";
import type { Bookmark } from "../services/bookmarks/bookmarkService";
import { container } from "../services/container";
import { shortcutFor, withShortcut } from "./shortcutLabel";
import { t } from "../i18n";

/** A bookmark's file shown relative to the open folder. */
function shownPath(path: string, root: string | null): string {
  const file = path.replace(/\\/g, "/");
  if (root === null) return file;
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return file.toLowerCase().startsWith(`${base.toLowerCase()}/`)
    ? file.slice(base.length + 1)
    : file;
}

function groupByFile(list: readonly Bookmark[]): [string, Bookmark[]][] {
  const groups = new Map<string, Bookmark[]>();
  for (const bm of list) {
    const items = groups.get(bm.path) ?? [];
    items.push(bm);
    groups.set(bm.path, items);
  }
  return [...groups.entries()];
}

function ToolbarButton({ id, glyph, disabled }: { id: string; glyph: string; disabled: boolean }) {
  const label = t(`command.${id}`);
  return (
    <button
      type="button"
      className="bookmarks__action"
      aria-label={label}
      title={withShortcut(label, id)}
      disabled={disabled}
      onClick={() => {
        container.run(id);
      }}
    >
      {glyph}
    </button>
  );
}

function BookmarkRowView({ bookmark }: { bookmark: Bookmark }) {
  const remove = t("bookmarks.remove", { line: bookmark.line });
  return (
    <li className="bookmarks__row">
      <button type="button" className="bookmarks__open" onClick={() => void openBookmark(bookmark)}>
        <span className="bookmarks__line">{t("bookmarks.line", { line: bookmark.line })}</span>
        {bookmark.label !== null ? (
          <span className="bookmarks__label">{bookmark.label}</span>
        ) : null}
      </button>
      <button
        type="button"
        className="bookmarks__remove"
        aria-label={remove}
        title={remove}
        onClick={() => {
          bookmarks.remove(bookmark.id);
        }}
      >
        ×
      </button>
    </li>
  );
}

/** Side bar view: the open folder's bookmarks, grouped by file; a click opens the line. */
export function BookmarksView() {
  useSyncExternalStore(
    (listener) => bookmarks.subscribe(listener),
    () => bookmarks.getState(),
  );
  const root = bookmarkRoot();
  const list = bookmarks.scoped(root);
  const toggleKey = shortcutFor("bookmarks.toggle");
  const empty = list.length === 0;
  return (
    <div className="bookmarks">
      <div className="bookmarks__toolbar">
        <ToolbarButton id="bookmarks.jumpToPrevious" glyph="↑" disabled={empty} />
        <ToolbarButton id="bookmarks.jumpToNext" glyph="↓" disabled={empty} />
        <ToolbarButton id="bookmarks.clearAll" glyph="⨯" disabled={empty} />
      </div>
      {empty ? (
        <p className="bookmarks__empty">
          {toggleKey === undefined
            ? t("bookmarks.empty")
            : t("bookmarks.emptyWithKey", { key: toggleKey })}
        </p>
      ) : (
        <ul className="bookmarks__files" aria-label={t("view.bookmarks")}>
          {groupByFile(list).map(([path, items]) => (
            <li key={path}>
              <div className="bookmarks__file" title={path}>
                {shownPath(path, root)}
              </div>
              <ul>
                {items.map((bm) => (
                  <BookmarkRowView key={bm.id} bookmark={bm} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
