import { describe, expect, it } from "vitest";

import type { ManifestEntry } from "./collabNetIpc";
import {
  EMPTY_TREE,
  ancestorsOf,
  applyDelta,
  collabUri,
  isCollabUri,
  parseCollabUri,
  treeFromView,
  visibleRows,
} from "./remoteTree";

const ROOM = "0123456789abcdef0123456789abcdef";
let n = 0;
function id(): string {
  n += 1;
  return n.toString(16).padStart(32, "0");
}

function entry(
  path: string,
  kind: "file" | "folder",
  parent: string | null,
  ownId = id(),
): ManifestEntry {
  return {
    id: ownId,
    parent,
    name: path.split("/").pop() ?? path,
    path,
    kind,
    size: kind === "file" ? 10 : 0,
    modifiedMs: 1,
    binaryHint: false,
  };
}

function sample() {
  const src = entry("src", "folder", null);
  const main = entry("src/main.ts", "file", src.id);
  const app = entry("src/App.tsx", "file", src.id);
  const util = entry("src/util", "folder", src.id);
  const readme = entry("README.md", "file", null);
  const tree = treeFromView({
    ready: true,
    version: 3,
    root: "My Project",
    entries: [main, readme, util, app, src],
  });
  return { tree, src, main, app, util, readme };
}

describe("remote tree", () => {
  it("sorts folders first, then names ignoring case, and shows only expanded folders' children", () => {
    const { tree, src, util, app, main, readme } = sample();
    expect(visibleRows(tree, new Set()).map((r) => r.entry.path)).toEqual(["src", "README.md"]);
    const rows = visibleRows(tree, new Set([src.id]));
    expect(rows.map((r) => [r.entry.path, r.depth])).toEqual([
      ["src", 0],
      ["src/util", 1],
      ["src/App.tsx", 1],
      ["src/main.ts", 1],
      ["README.md", 0],
    ]);
    expect(rows[0]?.expanded).toBe(true);
    expect(ancestorsOf(tree, main.id)).toEqual([src.id]);
    expect([util.id, app.id, readme.id].every((x) => tree.entries.has(x))).toBe(true);
  });

  it("applies deltas in order: a rename keeps the id, a removal drops it", () => {
    const { tree, main, src } = sample();
    const app = entry("app", "folder", null, src.id);
    const moved = { ...main, path: "app/main.ts" };
    const next = applyDelta(tree, { base: 3, version: 4, upserts: [app, moved], removed: [] });
    expect(next?.entries.get(main.id)?.path).toBe("app/main.ts");
    expect(next?.version).toBe(4);
    const gone = next && applyDelta(next, { base: 4, version: 5, upserts: [], removed: [main.id] });
    expect(gone?.entries.has(main.id)).toBe(false);
    expect(tree.entries.get(main.id)?.path).toBe("src/main.ts"); // the old tree is untouched
  });

  it("refuses a delta that doesn't follow, or arrives before the tree is ready", () => {
    const { tree } = sample();
    expect(applyDelta(tree, { base: 2, version: 4, upserts: [], removed: [] })).toBeNull();
    expect(applyDelta(tree, { base: 3, version: 3, upserts: [], removed: [] })).toBeNull();
    expect(applyDelta(EMPTY_TREE, { base: 0, version: 1, upserts: [], removed: [] })).toBeNull();
  });

  it("names a remote document by room and file id only", () => {
    const file = "fedcba9876543210fedcba9876543210";
    const uri = collabUri(ROOM, file);
    expect(uri).toBe(`omcollab://${ROOM}/${file}`);
    expect(parseCollabUri(uri)).toEqual({ roomUid: ROOM, fileId: file });
    expect(isCollabUri(uri)).toBe(true);
    for (const bad of ["C:/Users/alice/secret.ts", "src/main.ts", "../x", "", "ABCDEF0123456789"]) {
      expect(() => collabUri(ROOM, bad)).toThrow();
    }
    expect(parseCollabUri("omcollab://room/C:/x")).toBeNull();
    expect(parseCollabUri("file:///C:/x")).toBeNull();
  });
});
