import { describe, expect, it } from "vitest";

import type { ExplorerNode, ExplorerSnapshot } from "./explorerService";
import { isSameOrDescendant, pathSegments, visibleTreeRows } from "./explorerTree";

function node(path: string, parentPath: string, isDir: boolean): ExplorerNode {
  return { path, name: path.split("/").pop() ?? path, isDir, isSymlink: false, parentPath };
}

function snapshot(expanded: string[]): ExplorerSnapshot {
  const nodes = [
    node("/r/src", "/r", true),
    node("/r/src/a.ts", "/r/src", false),
    node("/r/src/lib", "/r/src", true),
    node("/r/src/lib/b.ts", "/r/src/lib", false),
    node("/r/README.md", "/r", false),
  ];
  return {
    rootPath: "/r",
    rootName: "r",
    nodesByPath: new Map(nodes.map((n) => [n.path, n])),
    childrenByPath: new Map([
      ["/r", ["/r/src", "/r/README.md"]],
      ["/r/src", ["/r/src/a.ts", "/r/src/lib"]],
      ["/r/src/lib", ["/r/src/lib/b.ts"]],
    ]),
    expandedPaths: new Set(expanded),
    selectedPath: null,
  };
}

describe("visibleTreeRows", () => {
  it("lists only top-level rows when nothing is expanded", () => {
    expect(visibleTreeRows(snapshot([])).map((row) => row.path)).toEqual([
      "/r/src",
      "/r/README.md",
    ]);
  });

  it("includes expanded directories' children with depth, in display order", () => {
    expect(visibleTreeRows(snapshot(["/r/src", "/r/src/lib"]))).toEqual([
      { path: "/r/src", depth: 0 },
      { path: "/r/src/a.ts", depth: 1 },
      { path: "/r/src/lib", depth: 1 },
      { path: "/r/src/lib/b.ts", depth: 2 },
      { path: "/r/README.md", depth: 0 },
    ]);
  });

  it("hides children of a collapsed ancestor even if the child dir is expanded", () => {
    const paths = visibleTreeRows(snapshot(["/r/src/lib"])).map((row) => row.path);
    expect(paths).not.toContain("/r/src/lib/b.ts");
  });
});

describe("isSameOrDescendant", () => {
  it("matches the path itself and its descendants, separator- and case-insensitively", () => {
    expect(isSameOrDescendant("C:\\r\\src", "C:/r/src")).toBe(true);
    expect(isSameOrDescendant("C:\\R\\src\\lib", "c:\\r\\src")).toBe(true);
  });

  it("does not treat a sibling sharing a name prefix as a descendant", () => {
    expect(isSameOrDescendant("C:\\r\\src2", "C:\\r\\src")).toBe(false);
  });
});

describe("pathSegments", () => {
  it("is relative to the workspace root (including the root folder) for files inside it", () => {
    expect(pathSegments("C:\\proj\\src\\a.ts", "C:\\proj")).toEqual([
      { name: "proj", path: "C:\\proj" },
      { name: "src", path: "C:\\proj\\src" },
      { name: "a.ts", path: "C:\\proj\\src\\a.ts" },
    ]);
  });

  it("uses the full path for files outside the workspace", () => {
    expect(pathSegments("D:/other/b.ts", "C:/proj").map((s) => s.name)).toEqual([
      "D:",
      "other",
      "b.ts",
    ]);
  });
});
