import { describe, expect, it } from "vitest";

import { layoutGraph } from "./commitGraph";
import { changeAt, diffLines, originalLineOf } from "./lineDiff";
import { commitUrl, encodePath, fileUri, fileUrl, parseRemote, vscodeDevUrl } from "./remoteUrls";

describe("parseRemote", () => {
  it.each([
    ["https://github.com/owner/repo.git", "github", "owner", "repo"],
    ["https://user@github.com/owner/repo", "github", "owner", "repo"],
    ["git@github.com:owner/repo.git", "github", "owner", "repo"],
    ["ssh://git@github.com/owner/repo.git", "github", "owner", "repo"],
    ["ssh://git@ssh.github.com:443/owner/repo.git", "github", "owner", "repo"],
    ["git://github.com/owner/repo", "github", "owner", "repo"],
    ["git@gitlab.com:group/sub/project.git", "gitlab", "group/sub", "project"],
    ["https://gitlab.com/group/project", "gitlab", "group", "project"],
    ["git@bitbucket.org:team/repo.git", "bitbucket", "team", "repo"],
    ["https://www.github.com/owner/repo/", "github", "owner", "repo"],
  ])("%s", (url, host, namespace, repo) => {
    expect(parseRemote(url)).toMatchObject({ host, namespace, repo });
  });

  it.each([
    "https://git.example.com/owner/repo.git",
    "git@gitlab.example.com:group/project.git",
    "https://github.com/owner",
    "https://github.com/owner/repo/extra",
    "file:///C:/repos/x.git",
    "C:/repos/x",
    "../relative/repo",
    "https://github.com/owner/../evil",
    "not a url",
  ])("refuses %s", (url) => {
    expect(parseRemote(url)).toBeNull();
  });
});

describe("remote addresses", () => {
  const github = parseRemote("git@github.com:o w/r.git");
  const gitlab = parseRemote("https://gitlab.com/g/s/p.git");
  const bitbucket = parseRemote("git@bitbucket.org:t/r.git");

  it("encodes every path segment and branch names with slashes", () => {
    expect(encodePath("src/a b/ü#?.ts")).toBe("src/a%20b/%C3%BC%23%3F.ts");
    if (!github) throw new Error("parse");
    expect(fileUrl(github, "feature/x y", "src/a b.ts", { start: 3, end: 7 })).toBe(
      "https://github.com/o%20w/r/blob/feature/x%20y/src/a%20b.ts#L3-L7",
    );
    expect(fileUrl(github, "abc1234", "a.ts", { start: 3, end: 3 })).toBe(
      "https://github.com/o%20w/r/blob/abc1234/a.ts#L3",
    );
  });

  it("uses each host's own file, line and commit scheme", () => {
    if (!gitlab || !bitbucket || !github) throw new Error("parse");
    expect(fileUrl(gitlab, "main", "a.ts", { start: 1, end: 2 })).toBe(
      "https://gitlab.com/g/s/p/-/blob/main/a.ts#L1-2",
    );
    expect(fileUrl(bitbucket, "main", "a.ts", { start: 1, end: 2 })).toBe(
      "https://bitbucket.org/t/r/src/main/a.ts#lines-1:2",
    );
    expect(fileUrl(bitbucket, "main", "a.ts", null)).toBe("https://bitbucket.org/t/r/src/main/a.ts");
    expect(commitUrl(github, "abc")).toBe("https://github.com/o%20w/r/commit/abc");
    expect(commitUrl(gitlab, "abc")).toBe("https://gitlab.com/g/s/p/-/commit/abc");
    expect(commitUrl(bitbucket, "abc")).toBe("https://bitbucket.org/t/r/commits/abc");
  });

  it("builds vscode.dev links for GitHub only", () => {
    if (!gitlab || !github) throw new Error("parse");
    expect(vscodeDevUrl(github, "abc1234", "src/a.ts", { start: 5, end: 9 })).toBe(
      "https://vscode.dev/github/o%20w/r/blob/abc1234/src/a.ts#L5",
    );
    expect(vscodeDevUrl(gitlab, "main", "a.ts", null)).toBeNull();
  });

  it("builds file URIs for Windows, UNC and POSIX paths", () => {
    expect(fileUri("C:\\My Project\\ü.ts", 4)).toBe("file:///C:/My%20Project/%C3%BC.ts#L4");
    expect(fileUri("\\\\server\\share\\a b.ts", null)).toBe("file://server/share/a%20b.ts");
    expect(fileUri("/home/me/a#b.ts", null)).toBe("file:///home/me/a%23b.ts");
  });
});

describe("diffLines", () => {
  it("finds added, modified and deleted lines", () => {
    const before = "a\nb\nc\nd\ne\n";
    const after = "a\nB\nc\nnew\nd\n";
    expect(diffLines(before, after)).toEqual([
      { kind: "modified", start: 2, end: 2, originalStart: 2, originalEnd: 2 },
      { kind: "added", start: 4, end: 4, originalStart: 4, originalEnd: 3 },
      { kind: "deleted", start: 6, end: 6, originalStart: 5, originalEnd: 5 },
    ]);
  });

  it("treats CRLF and LF the same and identical texts as unchanged", () => {
    expect(diffLines("a\r\nb\r\n", "a\nb\n")).toEqual([]);
    expect(diffLines("", "x\n")).toEqual([
      { kind: "added", start: 1, end: 1, originalStart: 1, originalEnd: 0 },
    ]);
    expect(diffLines("x\n", "")).toEqual([
      { kind: "deleted", start: 1, end: 1, originalStart: 1, originalEnd: 1 },
    ]);
  });

  it("gives up on a rewrite far past the limit instead of stalling", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `a${String(i)}`).join("\n");
    const b = Array.from({ length: 5000 }, (_, i) => `b${String(i)}`).join("\n");
    expect(diffLines(a, b)).toBeNull();
  });

  it("maps a line back to the old text and finds the change at a line", () => {
    const changes = diffLines("a\nb\nc\nd\n", "a\nx\ny\nc\n") ?? [];
    expect(originalLineOf(changes, 1)).toBe(1);
    expect(originalLineOf(changes, 2)).toBeNull();
    expect(originalLineOf(changes, 4)).toBe(3);
    expect(changeAt(changes, 3)?.kind).toBe("modified");
    const deleted = diffLines("a\nb\nc\n", "a\nc\n") ?? [];
    expect(originalLineOf(deleted, 2)).toBe(3);
  });
});

describe("layoutGraph", () => {
  it("keeps a straight history in one lane", () => {
    const rows = layoutGraph([
      { hash: "c", parents: ["b"] },
      { hash: "b", parents: ["a"] },
      { hash: "a", parents: [] },
    ]);
    expect(rows.map((row) => row.column)).toEqual([0, 0, 0]);
    expect(rows[2]?.segments).toEqual([{ x1: 0, y1: 0, x2: 0, y2: 0.5, lane: 0 }]);
  });

  it("opens a lane for a merge's second parent and joins it again", () => {
    const rows = layoutGraph([
      { hash: "m", parents: ["a", "b"] },
      { hash: "b", parents: ["base"] },
      { hash: "a", parents: ["base"] },
      { hash: "base", parents: [] },
    ]);
    expect(rows[0]?.width).toBe(2);
    expect(rows[1]?.column).toBe(1);
    expect(rows[2]?.column).toBe(0);
    // The second lane joins the first above the base commit.
    expect(rows[2]?.segments).toContainEqual({ x1: 1, y1: 0, x2: 0, y2: 1, lane: 0 });
    expect(rows[3]?.column).toBe(0);
    expect(rows[3]?.width).toBe(1);
  });
});
