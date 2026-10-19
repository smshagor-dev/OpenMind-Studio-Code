import { invoke } from "@tauri-apps/api/core";

/** A bookmark as stored: absolute path, 1-based line, an optional label. */
export interface BookmarkRow {
  filePath: string;
  line: number;
  label?: string | null;
}

export interface BookmarksIpc {
  load: () => Promise<BookmarkRow[]>;
  save: (rows: BookmarkRow[]) => Promise<void>;
}

export const tauriBookmarksIpc: BookmarksIpc = {
  load: () => invoke<BookmarkRow[]>("bookmarks_load"),
  save: (rows) => invoke("bookmarks_save", { rows }),
};
