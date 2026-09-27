/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUNDLE_FORMAT,
  bundleManifest,
  licenseOf,
  noticesText,
  packFileName,
  safeRelative,
  strippedName,
  validateLspBundle,
} from "../../scripts/lspBundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));

const SHA = "a".repeat(64);
const expected = [
  { id: "python", revision: "1", contents: "pyright 1.1.414", redistributable: true },
  { id: "php", revision: "1", contents: "intelephense 1.18.5", redistributable: false },
  { id: "rust", revision: "1", contents: "rust-analyzer", redistributable: true },
];

function goodManifest() {
  return bundleManifest({
    createdAt: "2026-09-27T00:00:00Z",
    node: { version: "24.21.0", path: "node/node.exe", sha256: SHA, size: 10, license: "MIT" },
    packs: [
      {
        package: "rust",
        revision: "1",
        contents: "",
        file: "packs/rust-1.zip",
        sha256: SHA,
        size: 5,
        license: "MIT",
      },
      {
        package: "python",
        revision: "1",
        contents: "",
        file: "packs/python-1.zip",
        sha256: SHA,
        size: 7,
        license: "MIT",
      },
    ],
  });
}

const sizes: Record<string, number> = {
  "node/node.exe": 10,
  "packs/rust-1.zip": 5,
  "packs/python-1.zip": 7,
};
const fileSize = (path: string) => sizes[path] ?? null;

describe("LSP bundle names and paths", () => {
  it("names packs by package and revision and refuses anything else", () => {
    expect(packFileName("python", "1")).toBe("packs/python-1.zip");
    expect(() => packFileName("../x", "1")).toThrow();
    expect(() => packFileName("python", "1/2")).toThrow();
  });

  it("keeps every bundle path inside lsp/", () => {
    expect(safeRelative("packs/python-1.zip")).toBe(true);
    for (const bad of [
      "",
      "../x.zip",
      "packs/../../x",
      "C:/x.zip",
      "/abs",
      "packs\\x.zip",
      "a//b",
    ]) {
      expect(safeRelative(bad), bad).toBe(false);
    }
  });

  it("strips leading folders and drops folders and skipped files", () => {
    expect(strippedName("clangd_22.1.6/bin/clangd.exe", 1)).toBe("bin/clangd.exe");
    expect(strippedName("clangd_22.1.6/", 1)).toBeNull();
    expect(strippedName("rust_analyzer.pdb", 0, ["rust_analyzer.pdb"])).toBeNull();
    expect(strippedName("sub\\file.txt", 0)).toBe("sub/file.txt");
  });
});

describe("validateLspBundle", () => {
  it("accepts a complete bundle and sorts its packs", () => {
    const manifest = goodManifest();
    expect(manifest.format).toBe(BUNDLE_FORMAT);
    expect(manifest.packs.map((pack) => pack.package)).toEqual(["python", "rust"]);
    expect(validateLspBundle(manifest, expected, fileSize)).toEqual([]);
  });

  it("reports a missing pack, a wrong revision, a truncated file and a missing licence", () => {
    const manifest = goodManifest();
    manifest.packs = manifest.packs
      .filter((pack) => pack.package !== "rust")
      .map((pack) => ({ ...pack, revision: "0", size: 99, license: "" }));
    const problems = validateLspBundle(manifest, expected, fileSize).join(" | ");
    expect(problems).toContain('No pack for "rust"');
    expect(problems).toContain("revision 0");
    expect(problems).toContain("size doesn't match");
    expect(problems).toContain("no licence note");
  });

  it("refuses a pack of a package that may not be redistributed", () => {
    const manifest = goodManifest();
    manifest.packs.push({
      package: "php",
      revision: "1",
      contents: "",
      file: "packs/php-1.zip",
      sha256: SHA,
      size: 1,
      license: "SEE LICENSE",
    });
    expect(validateLspBundle(manifest, expected, fileSize).join(" ")).toContain(
      "may not be redistributed",
    );
  });

  it("refuses a foreign file, no Node.js and unsafe paths", () => {
    const problems = validateLspBundle(
      { format: "x", version: 1, platform: "linux", node: null, packs: [] },
      [],
      fileSize,
    ).join(" ");
    expect(problems).toContain("not an OpenMind LSP bundle");
    expect(problems).toContain("windows-x64");
    expect(problems).toContain("Node.js");
    const unsafe = goodManifest();
    unsafe.packs = unsafe.packs.map((pack) => ({ ...pack, file: "../../evil.zip" }));
    expect(validateLspBundle(unsafe, expected, fileSize).join(" ")).toContain("invalid file name");
  });
});

describe("licences", () => {
  it("reads every form of the licence field", () => {
    expect(licenseOf({ license: "MIT" })).toBe("MIT");
    expect(licenseOf({ license: { type: "ISC" } })).toBe("ISC");
    expect(licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
      "MIT OR Apache-2.0",
    );
    expect(licenseOf({})).toBe("");
  });

  it("lists every component under its pack", () => {
    const text = noticesText([
      {
        title: "pyright 1.1.414",
        items: [{ name: "pyright", version: "1.1.414", license: "MIT" }],
      },
    ]);
    expect(text).toContain("== pyright 1.1.414 ==");
    expect(text).toContain("pyright@1.1.414  MIT");
  });
});

describe("the pinned sources", () => {
  it("pin the same Node.js as the Runtime Manager and a SHA256 for every download", () => {
    const sources = json("crates/lsp/servers/bundle-sources.json") as {
      platform: string;
      node: { version: string; url: string; sha256: string };
      native: { url: string; sha256: string }[];
    };
    const runtime = json("crates/runtime-manager/manifests/node.json") as {
      versions: { version: string; artifacts: { url: string; sha256: string }[] }[];
    };
    const pinned = runtime.versions.find((entry) => entry.version === sources.node.version);
    expect(pinned?.artifacts[0]?.url).toBe(sources.node.url);
    expect(pinned?.artifacts[0]?.sha256).toBe(sources.node.sha256);
    expect(sources.platform).toBe("windows-x64");
    for (const entry of sources.native) {
      expect(entry.url.startsWith("https://")).toBe(true);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("ship the bundle next to the executable as lsp/ in the installers", () => {
    const tauri = json("src-tauri/tauri.conf.json") as {
      bundle: { resources: Record<string, string> };
    };
    expect(tauri.bundle.resources["../lsp-bundle/"]).toBe("lsp/");
  });
});
