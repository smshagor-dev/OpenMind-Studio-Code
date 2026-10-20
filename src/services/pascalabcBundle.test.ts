/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ARCHIVE,
  LICENSE_FILES,
  NOTICE,
  archiveProblem,
  bundleRecord,
  pinnedArtifact,
  validateBundle,
} from "../../scripts/pascalabcBundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest: unknown = JSON.parse(
  readFileSync(join(root, "crates/runtime-manager/manifests/pascalabc.json"), "utf8"),
);
const pinned = pinnedArtifact(manifest);

describe("PascalABC.NET bundle", () => {
  it("pins the official console ZIP the manifest names", () => {
    expect(pinned).toEqual({
      version: "4.0.0.3883",
      url: "https://pascalabc.net/downloads/PABCNETC.zip",
      sha256: "256eb56fa904e4ac99a1d4c867594a945dcfce8bcb7680e623c20477f3c5754f",
      size: 10631071,
    });
  });

  it("accepts only the pinned archive, and says when pascalabc.net published another build", () => {
    expect(archiveProblem(pinned, { sha256: pinned.sha256, size: pinned.size })).toBeNull();
    expect(archiveProblem(pinned, { sha256: pinned.sha256, size: 1 })).toContain("is 1 bytes");
    expect(archiveProblem(pinned, { sha256: "0".repeat(64), size: pinned.size })).toContain(
      "update the manifest first",
    );
  });

  it("writes the record the app reads and reports what a built bundle lacks", () => {
    const record = bundleRecord(pinned);
    expect(record).toMatchObject({
      format: "openmind-pascalabc-bundle",
      version: 1,
      compilerVersion: "4.0.0.3883",
      file: ARCHIVE,
      source: pinned.url,
    });
    expect(validateBundle(record, pinned, [ARCHIVE, ...LICENSE_FILES])).toEqual([]);
    expect(validateBundle(record, pinned, [ARCHIVE])).toContain("License_en.txt is missing");
    expect(validateBundle({ ...record, sha256: "x" }, pinned, [ARCHIVE, ...LICENSE_FILES])[0]).toContain(
      "bundle.json sha256",
    );
  });

  it("ships the licence texts the LGPL and the Programming Taskbook licence require", () => {
    for (const name of LICENSE_FILES.filter((n) => n !== "NOTICE.txt")) {
      expect(existsSync(join(root, "licenses", "pascalabc", name)), name).toBe(true);
    }
    const lgpl = readFileSync(join(root, "licenses/pascalabc/License_en.txt"), "utf8");
    expect(lgpl).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
    expect(readFileSync(join(root, "licenses/pascalabc/GPL-3.0.txt"), "utf8")).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(readFileSync(join(root, "licenses/pascalabc/PT4-license-en.txt"), "utf8")).toContain(
      "the distribution package is not modified",
    );
    expect(NOTICE).toContain("https://github.com/pascalabcnet/pascalabcnet");
    expect(NOTICE).toContain("unmodified");
  });

  it("is shipped with Windows builds only and kept by portable updates", () => {
    const conf = (name: string) =>
      JSON.parse(readFileSync(join(root, "src-tauri", name), "utf8")) as {
        bundle: { resources: Record<string, string | null> };
      };
    expect(conf("tauri.conf.json").bundle.resources["../pascalabc-bundle/"]).toBe("pascalabc-bundle/");
    expect(conf("tauri.linux.conf.json").bundle.resources["../pascalabc-bundle/"]).toBeNull();
    expect(conf("tauri.macos.conf.json").bundle.resources["../pascalabc-bundle/"]).toBeNull();
    const portable = readFileSync(join(root, "src-tauri/src/updates/portable.rs"), "utf8");
    expect(portable).toContain('"pascalabc-bundle",');
    expect(existsSync(join(root, "pascalabc-bundle", "README.txt"))).toBe(true);
  });
});
