import type { ManifestEntry, RemoteTreeView } from "./collabNetIpc";

/**
 * A participant's copy of the Owner's shared tree, as plain immutable data (the backend's `RemoteTree` is the
 * authority; this mirrors it for rendering). Entries are keyed by their stable file id; children are sorted folders
 * first, then by name, the way the local Explorer sorts.
 */
export interface RemoteTree {
  ready: boolean;
  version: number;
  root: string;
  entries: ReadonlyMap<string, ManifestEntry>;
  /** Parent id (`""` for the top level) -> child ids, sorted. */
  children: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_TREE: RemoteTree = {
  ready: false,
  version: 0,
  root: "",
  entries: new Map(),
  children: new Map(),
};

const ROOT = "";

function compare(a: ManifestEntry, b: ManifestEntry): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  const lower = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return lower !== 0 ? lower : a.name.localeCompare(b.name);
}

function index(entries: ReadonlyMap<string, ManifestEntry>): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const entry of entries.values()) {
    // An entry whose parent isn't listed (shouldn't happen) is shown at the top rather than lost.
    const parent = entry.parent !== null && entries.has(entry.parent) ? entry.parent : ROOT;
    const list = children.get(parent) ?? [];
    list.push(entry.id);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => {
      const left = entries.get(a);
      const right = entries.get(b);
      return left && right ? compare(left, right) : 0;
    });
  }
  return children;
}

export function treeFromView(view: RemoteTreeView): RemoteTree {
  const entries = new Map(view.entries.map((entry) => [entry.id, entry]));
  return {
    ready: view.ready,
    version: view.version,
    root: view.root,
    entries,
    children: index(entries),
  };
}

/** Applies a delta that follows `tree.version`; `null` means it doesn't follow (ask for the tree again). */
export function applyDelta(
  tree: RemoteTree,
  delta: {
    base: number;
    version: number;
    upserts: readonly ManifestEntry[];
    removed: readonly string[];
  },
): RemoteTree | null {
  if (!tree.ready || delta.base !== tree.version || delta.version <= delta.base) return null;
  const entries = new Map(tree.entries);
  for (const id of delta.removed) entries.delete(id);
  for (const entry of delta.upserts) entries.set(entry.id, entry);
  return { ...tree, version: delta.version, entries, children: index(entries) };
}

export interface RemoteRow {
  entry: ManifestEntry;
  depth: number;
  expanded: boolean;
}

/** The rows an Explorer-style list shows: top level, then the children of every expanded folder, depth first. */
export function visibleRows(tree: RemoteTree, expanded: ReadonlySet<string>): RemoteRow[] {
  const rows: RemoteRow[] = [];
  const walk = (parent: string, depth: number): void => {
    for (const id of tree.children.get(parent) ?? []) {
      const entry = tree.entries.get(id);
      if (!entry) continue;
      const open = entry.kind === "folder" && expanded.has(id);
      rows.push({ entry, depth, expanded: open });
      if (open) walk(id, depth + 1);
    }
  };
  walk(ROOT, 0);
  return rows;
}

/** The ids of `id` and every folder above it (to reveal an entry). */
export function ancestorsOf(tree: RemoteTree, id: string): string[] {
  const chain: string[] = [];
  let current = tree.entries.get(id)?.parent ?? null;
  while (current !== null && !chain.includes(current)) {
    chain.push(current);
    current = tree.entries.get(current)?.parent ?? null;
  }
  return chain;
}

const SCHEME = "omcollab";
/** Room and file ids are lowercase hex (`openmind_collab::ids`). */
const ID = /^[0-9a-f]{16,64}$/;

/**
 * The identity of a remote document: `omcollab://<room id>/<file id>`. Both parts are opaque ids, so the Owner's
 * folder can never appear in it (a path is not an id and is refused).
 */
export function collabUri(roomUid: string, fileId: string): string {
  if (!ID.test(roomUid) || !ID.test(fileId))
    throw new Error("Not a collaboration room or file id.");
  return `${SCHEME}://${roomUid}/${fileId}`;
}

export function parseCollabUri(uri: string): { roomUid: string; fileId: string } | null {
  const match = /^omcollab:\/\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match) return null;
  const [, roomUid = "", fileId = ""] = match;
  return ID.test(roomUid) && ID.test(fileId) ? { roomUid, fileId } : null;
}

export function isCollabUri(uri: string): boolean {
  return uri.startsWith(`${SCHEME}://`);
}
