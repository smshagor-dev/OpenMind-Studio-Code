import { pathKey } from "../textSync";
import type { BookmarkRow, BookmarksIpc } from "./bookmarksIpc";

export interface Bookmark {
  id: string;
  path: string;
  /** 1-based. */
  line: number;
  label: string | null;
}

export interface BookmarkState {
  bookmarks: readonly Bookmark[];
}

/** How long after the last change the bookmarks are written to the database. */
export const SAVE_DELAY_MS = 300;
const LABEL_LENGTH = 200;

function cleanLabel(label: string | null | undefined): string | null {
  const text = label?.replace(/\s+/g, " ").trim().slice(0, LABEL_LENGTH) ?? "";
  return text === "" ? null : text;
}

function trimmedKey(path: string): string {
  return pathKey(path).replace(/\/+$/, "");
}

/** Whether `path` is inside the folder `root` (no folder = everything is in scope). */
export function inScope(path: string, root: string | null): boolean {
  if (root === null) return true;
  return pathKey(path).startsWith(`${trimmedKey(root)}/`);
}

/** Bookmarks in navigation order: by file, then line. */
export function ordered(list: readonly Bookmark[]): Bookmark[] {
  return [...list].sort((a, b) => {
    const pa = pathKey(a.path);
    const pb = pathKey(b.path);
    if (pa === pb) return a.line - b.line;
    return pa < pb ? -1 : 1;
  });
}

/**
 * The bookmark after (`direction` 1) or before (-1) the place `here`, wrapping around; across files in path order.
 * Without a place the first (or last) one.
 */
export function neighbour(
  list: readonly Bookmark[],
  here: { path: string; line: number } | null,
  direction: 1 | -1,
): Bookmark | undefined {
  const sorted = ordered(list);
  if (sorted.length === 0) return undefined;
  if (here === null) return direction === 1 ? sorted[0] : sorted.at(-1);
  const key = pathKey(here.path);
  const compare = (bm: Bookmark): number => {
    const k = pathKey(bm.path);
    if (k === key) return bm.line - here.line;
    return k < key ? -1 : 1;
  };
  if (direction === 1) return sorted.find((bm) => compare(bm) > 0) ?? sorted[0];
  return [...sorted].reverse().find((bm) => compare(bm) < 0) ?? sorted.at(-1);
}

/** `path` after its folder (or the file itself) `from` was renamed or moved to `to`; `null` when it isn't under it. */
function movedPath(path: string, from: string, to: string): string | null {
  const key = pathKey(path);
  const old = trimmedKey(from);
  if (key === old) return to;
  if (!key.startsWith(`${old}/`)) return null;
  const rest = path.replace(/\\/g, "/").slice(old.length + 1);
  return `${to.replace(/[\\/]+$/, "")}/${rest}`;
}

/**
 * Editor bookmarks (VS Code's Bookmarks extension): a line of a file, optionally labelled, toggled from a command,
 * kept in SQLite so they survive a relaunch, and moved with their line when text above them changes. By absolute
 * path; the commands and the view work on the open folder's bookmarks.
 */
export class BookmarkService {
  private state: BookmarkState = { bookmarks: [] };
  private readonly listeners = new Set<() => void>();
  private nextId = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ipc: BookmarksIpc) {}

  getState(): BookmarkState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    let rows: BookmarkRow[];
    try {
      rows = await this.ipc.load();
    } catch {
      return;
    }
    this.state = {
      bookmarks: rows.map((row) => ({
        id: this.newId(),
        path: row.filePath,
        line: Math.max(1, row.line),
        label: cleanLabel(row.label),
      })),
    };
    this.notify();
  }

  private newId(): string {
    this.nextId += 1;
    return `bm-${String(this.nextId)}`;
  }

  forFile(path: string): Bookmark[] {
    const key = pathKey(path);
    return this.state.bookmarks
      .filter((bm) => pathKey(bm.path) === key)
      .sort((a, b) => a.line - b.line);
  }

  at(path: string, line: number): Bookmark | undefined {
    return this.forFile(path).find((bm) => bm.line === line);
  }

  /** The bookmarks inside `root`, in navigation order. */
  scoped(root: string | null): Bookmark[] {
    return ordered(this.state.bookmarks.filter((bm) => inScope(bm.path, root)));
  }

  /** Adds a bookmark at `path:line`, or removes the one there. Returns whether one exists now. */
  toggle(path: string, line: number, label: string | null = null): boolean {
    const existing = this.at(path, line);
    if (existing) {
      this.commit(this.state.bookmarks.filter((bm) => bm.id !== existing.id));
      return false;
    }
    const added: Bookmark = { id: this.newId(), path, line, label: cleanLabel(label) };
    this.commit([...this.state.bookmarks, added]);
    return true;
  }

  /** Sets (or, with empty text, clears) a bookmark's label. */
  setLabel(id: string, label: string | null): void {
    if (!this.state.bookmarks.some((bm) => bm.id === id)) return;
    this.commit(
      this.state.bookmarks.map((bm) => (bm.id === id ? { ...bm, label: cleanLabel(label) } : bm)),
    );
  }

  remove(id: string): void {
    if (!this.state.bookmarks.some((bm) => bm.id === id)) return;
    this.commit(this.state.bookmarks.filter((bm) => bm.id !== id));
  }

  clearFile(path: string): void {
    const key = pathKey(path);
    const next = this.state.bookmarks.filter((bm) => pathKey(bm.path) !== key);
    if (next.length !== this.state.bookmarks.length) this.commit(next);
  }

  /** Removes the bookmarks inside `root` (every bookmark without a folder). */
  clearScope(root: string | null): void {
    const next = this.state.bookmarks.filter((bm) => !inScope(bm.path, root));
    if (next.length !== this.state.bookmarks.length) this.commit(next);
  }

  /** A file or folder was renamed or moved: its bookmarks follow it. */
  retarget(from: string, to: string): void {
    if (!this.state.bookmarks.some((bm) => movedPath(bm.path, from, to) !== null)) return;
    this.commit(
      this.state.bookmarks.map((bm) => {
        const path = movedPath(bm.path, from, to);
        return path === null ? bm : { ...bm, path };
      }),
    );
  }

  /** Bookmarks followed an edit: their lines moved (from the editor's tracked decorations). */
  moveLines(moves: { id: string; line: number }[]): void {
    const byId = new Map(moves.map((move) => [move.id, move.line]));
    const changed = this.state.bookmarks.some(
      (bm) => byId.has(bm.id) && byId.get(bm.id) !== bm.line,
    );
    if (!changed) return;
    // Two bookmarks squeezed onto one line by a deletion become one.
    const seen = new Set<string>();
    const next: Bookmark[] = [];
    for (const bm of this.state.bookmarks) {
      const line = byId.get(bm.id) ?? bm.line;
      const key = `${pathKey(bm.path)}:${String(line)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ ...bm, line });
    }
    this.commit(next);
  }

  private commit(next: Bookmark[]): void {
    this.state = { bookmarks: next };
    this.notify();
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, SAVE_DELAY_MS);
  }

  /** Writes every bookmark to the database now. */
  async saveNow(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const rows: BookmarkRow[] = this.state.bookmarks.map((bm) => ({
      filePath: bm.path,
      line: bm.line,
      ...(bm.label !== null ? { label: bm.label } : {}),
    }));
    await this.ipc.save(rows).catch(() => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
