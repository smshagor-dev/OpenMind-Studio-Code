/// <reference types="node" />
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { releaseFiles, verifyManifest, writeManifest } from "../../scripts/releaseManifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dirs: string[] = [];

function releaseFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-release-"));
  dirs.push(dir);
  mkdirSync(join(dir, "windows"));
  mkdirSync(join(dir, "linux"));
  writeFileSync(join(dir, "windows", "OpenMind-Studio_1.0.3_windows_x64_setup.exe"), "setup");
  writeFileSync(join(dir, "windows", "OpenMind-Studio_1.0.3_windows_x64_setup.exe.sig"), "sig");
  writeFileSync(join(dir, "linux", "OpenMind-Studio_1.0.3_linux_x86.deb"), "deb");
  writeFileSync(join(dir, "RELEASE-NOTES-1.0.3-DRAFT.md"), "notes");
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("release folder manifest", () => {
  it("lists every release file of windows/ and linux/ with its relative path, and verifies it", () => {
    const dir = releaseFolder();
    expect(releaseFiles(dir).map((file) => file.name)).toEqual([
      "OpenMind-Studio_1.0.3_windows_x64_setup.exe",
      "OpenMind-Studio_1.0.3_linux_x86.deb",
    ]);
    writeManifest(dir);
    const lines = readFileSync(join(dir, "SHA256SUMS.txt"), "utf8").trim().split("\n");
    expect(lines.map((line) => line.slice(66))).toEqual([
      "linux/OpenMind-Studio_1.0.3_linux_x86.deb",
      "windows/OpenMind-Studio_1.0.3_windows_x64_setup.exe",
    ]);
    expect(verifyManifest(dir)).toEqual([]);
  });

  it("reports a changed, a missing and an unlisted file", () => {
    const dir = releaseFolder();
    writeManifest(dir);
    writeFileSync(join(dir, "linux", "OpenMind-Studio_1.0.3_linux_x86.deb"), "changed");
    writeFileSync(join(dir, "windows", "OpenMind-Studio_1.0.3_windows_x86.msi"), "msi");
    expect(verifyManifest(dir)).toEqual([
      "linux/OpenMind-Studio_1.0.3_linux_x86.deb: SHA-256 differs",
      "windows/OpenMind-Studio_1.0.3_windows_x86.msi: not in SHA256SUMS.txt",
    ]);
    rmSync(join(dir, "windows", "OpenMind-Studio_1.0.3_windows_x64_setup.exe"));
    expect(verifyManifest(dir)).toContain("windows/OpenMind-Studio_1.0.3_windows_x64_setup.exe: missing");
  });

  it("the release scripts write only into the project's release folder", () => {
    const script = (path: string) => readFileSync(join(root, path), "utf8");
    expect(script("scripts/release.mjs")).toContain("const out = releaseDir(root, version);");
    expect(script("scripts/package-portable.mjs")).toContain('join("release", "staging", "portable")');
    expect(script("scripts/linux-release.sh")).toContain('out="$root/release/v$version/linux"');
    expect(script("scripts/linux-release.sh")).not.toMatch(/git clone|cp -r .*src/);
    const workflow = script(".github/workflows/release-windows.yml");
    expect(workflow).toContain("path: release/v*/");
    expect(workflow).toContain("path: release/v*/linux/");
    expect(script(".gitignore")).toMatch(/^\/release\/$/m);
  });
});
