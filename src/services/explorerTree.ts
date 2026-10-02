import type { ExplorerSnapshot } from "./explorerService";

export interface VisibleRow {
  path: string;
  depth: number;
}

/**
 * The explorer tree flattened to the rows currently on screen (root's children, plus the loaded
 * children of every expanded directory), in display order. Drives keyboard navigation — the same
 * order the rows render in.
 */
export function visibleTreeRows(snapshot: ExplorerSnapshot): VisibleRow[] {
  const rows: VisibleRow[] = [];
  if (!snapshot.rootPath) {
    return rows;
  }
  const visit = (dir: string, depth: number) => {
    for (const path of snapshot.childrenByPath.get(dir) ?? []) {
      rows.push({ path, depth });
      if (snapshot.nodesByPath.get(path)?.isDir && snapshot.expandedPaths.has(path)) {
        visit(path, depth + 1);
      }
    }
  };
  visit(snapshot.rootPath, 0);
  return rows;
}

/** True when `candidate` is `ancestor` itself or lies inside it — a folder can't be moved into its own subtree. */
export function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  const a = normalize(ancestor);
  const c = normalize(candidate);
  return c === a || c.startsWith(`${a}/`);
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export interface PathSegment {
  name: string;
  /** The full path up to and including this segment, in the original path's own separator style. */
  path: string;
}

/**
 * Breadcrumb segments for `filePath`: relative to `rootPath` when the file lives inside it (the
 * first segment is then the workspace folder itself), otherwise the full absolute path.
 */
export function pathSegments(filePath: string, rootPath: string | null): PathSegment[] {
  const segments: PathSegment[] = [];
  const pattern = /[^\\/]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(filePath)) !== null) {
    segments.push({ name: match[0], path: filePath.slice(0, match.index + match[0].length) });
  }
  if (rootPath && isSameOrDescendant(filePath, rootPath)) {
    const rootDepth = rootPath.split(/[\\/]+/).filter(Boolean).length;
    return segments.slice(rootDepth - 1);
  }
  return segments;
}

export type DisplayRow = { path: string; depth: number; draft?: undefined } | { path: null; depth: number; draft: "file" | "folder" };

/** The visible rows plus, while a new item is being named, its name box first inside its folder. */
export function withDraft(
  rows: readonly { path: string; depth: number }[],
  rootPath: string,
  creating: { parentDir: string; kind: "file" | "folder" } | null,
): DisplayRow[] {
  const display: DisplayRow[] = rows.map((row) => ({ path: row.path, depth: row.depth }));
  if (creating === null) return display;
  const draft = (depth: number): DisplayRow => ({ path: null, depth, draft: creating.kind });
  if (creating.parentDir === rootPath) return [draft(0), ...display];
  const parent = rows.findIndex((row) => row.path === creating.parentDir);
  if (parent < 0) return [draft(0), ...display];
  const depth = (rows[parent]?.depth ?? 0) + 1;
  return [...display.slice(0, parent + 1), draft(depth), ...display.slice(parent + 1)];
}
