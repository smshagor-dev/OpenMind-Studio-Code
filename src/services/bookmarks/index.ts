// Editor bookmarks of this window, built from the app's own services (kept out of container.ts, which is at its size
// limit, like the agent). `startBookmarks` runs once the workbench is ready.
import { container } from "../container";
import { t } from "../../i18n";
import { registerBookmarkCommands } from "./bookmarkCommands";
import { registerBookmarkEditorBinding } from "./bookmarkEditorBinding";
import { BookmarkService, type Bookmark } from "./bookmarkService";
import { tauriBookmarksIpc } from "./bookmarksIpc";

export const bookmarks = new BookmarkService(tauriBookmarksIpc);

/** The open folder, or `null`. */
export function bookmarkRoot(): string | null {
  return container.workspace.getActiveWorkspace()?.path ?? null;
}

/** Opens a bookmark's file at its line. */
export async function openBookmark(bookmark: Bookmark): Promise<void> {
  await container.workspace.openPathAt(bookmark.path, {
    line: bookmark.line,
    column: 1,
    length: 0,
  });
}

function here(): { path: string; line: number } | null {
  const file = container.activeFile();
  const line = container.editor.getStatus()?.line;
  if (!file || line === undefined || !container.editor.hasEditor()) return null;
  return { path: file.path, line };
}

function tooltip(bookmark: Bookmark): string {
  return bookmark.label === null
    ? t("bookmarks.tooltip")
    : t("bookmarks.tooltipLabel", { label: bookmark.label });
}

let started = false;

/** Loads the saved bookmarks, draws them in every editor and registers the commands (once). */
export async function startBookmarks(): Promise<void> {
  if (started) return;
  started = true;
  registerBookmarkCommands({
    commands: container.commands,
    bookmarks,
    here,
    root: bookmarkRoot,
    open: openBookmark,
    showView: () => container.layout.showView("bookmarks"),
    askLabel: (current) =>
      container.extensions.prompts.inputBox({
        extension: t("bookmarks.source"),
        title: t("bookmarks.labelTitle"),
        prompt: t("bookmarks.labelPrompt"),
        placeHolder: t("bookmarks.labelPlaceholder"),
        value: current,
        password: false,
      }),
    confirmClear: async (count) =>
      (await container.extensions.prompts.confirm({
        extension: t("bookmarks.source"),
        title: t("bookmarks.clearTitle", { count }),
        details: [{ label: t("bookmarks.folder"), value: bookmarkRoot() ?? t("bookmarks.noFolder") }],
        notes: [],
        buttons: [t("bookmarks.clearButton")],
      })) !== null,
  });
  // A renamed or saved-as file keeps its bookmarks.
  container.events.on("documentPathChanged", ({ from, to }) => {
    if (from !== null) bookmarks.retarget(from, to);
  });
  registerBookmarkEditorBinding({ documents: container.documents, bookmarks, tooltip });
  await bookmarks.initialize();
}
