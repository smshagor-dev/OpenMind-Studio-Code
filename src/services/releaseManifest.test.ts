/// <reference types="node" />
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  manifestPath,
  misplacedFiles,
  releaseFiles,
  verifyManifest,
  writeManifest,
} from "../../scripts/releaseManifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dirs: string[] = [];

function put(dir: string, path: string, content: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function releaseFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-release-"));
  dirs.push(dir);
  put(dir, "windows/x64/OpenMind-Studio_1.0.3_windows_x64_setup.exe", "setup");
  put(dir, "windows/x64/OpenMind-Studio_1.0.3_windows_x64_setup.exe.sig", "sig");
  put(dir, "linux/x86/OpenMind-Studio_1.0.3_linux_x86.deb", "deb");
  put(dir, "macos/arm64/OpenMind-Studio_1.0.3_macos_arm64.dmg", "dmg");
  put(dir, "metadata/RELEASE-NOTES.md", "notes");
  put(dir, "launchers/windows/Start OpenMind Studio.bat", "@echo off");
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("release folder manifest", () => {
  it("lists every release file of <platform>/<arch>/ and writes bare names into metadata/SHA256SUMS.txt", () => {
    const dir = releaseFolder();
    expect(releaseFiles(dir).map((file) => file.path)).toEqual([
      "windows/x64/OpenMind-Studio_1.0.3_windows_x64_setup.exe",
      "linux/x86/OpenMind-Studio_1.0.3_linux_x86.deb",
      "macos/arm64/OpenMind-Studio_1.0.3_macos_arm64.dmg",
    ]);
    writeManifest(dir);
    expect(manifestPath(dir)).toBe(join(dir, "metadata", "SHA256SUMS.txt"));
    const lines = readFileSync(manifestPath(dir), "utf8").trim().split("\n");
    // Bare names: the same file verifies a flat download of the GitHub release with `sha256sum -c`.
    expect(lines.map((line) => line.slice(66))).toEqual([
      "OpenMind-Studio_1.0.3_linux_x86.deb",
      "OpenMind-Studio_1.0.3_macos_arm64.dmg",
      "OpenMind-Studio_1.0.3_windows_x64_setup.exe",
    ]);
    expect(verifyManifest(dir)).toEqual([]);
  });

  it("reports a changed, a missing and an unlisted file", () => {
    const dir = releaseFolder();
    writeManifest(dir);
    put(dir, "linux/x86/OpenMind-Studio_1.0.3_linux_x86.deb", "changed");
    put(dir, "windows/x86/OpenMind-Studio_1.0.3_windows_x86.msi", "msi");
    expect(verifyManifest(dir)).toEqual([
      "OpenMind-Studio_1.0.3_linux_x86.deb: SHA-256 differs",
      "windows/x86/OpenMind-Studio_1.0.3_windows_x86.msi: not in SHA256SUMS.txt",
    ]);
    rmSync(join(dir, "windows", "x64", "OpenMind-Studio_1.0.3_windows_x64_setup.exe"));
    expect(verifyManifest(dir)).toContain("OpenMind-Studio_1.0.3_windows_x64_setup.exe: missing");
  });

  it("a file in the folder of another architecture is refused, never listed", () => {
    const dir = releaseFolder();
    put(dir, "windows/x64/OpenMind-Studio_1.0.3_windows_x86_portable.zip", "x86 in the x64 folder");
    expect(misplacedFiles(dir)).toEqual([
      "windows/x64/OpenMind-Studio_1.0.3_windows_x86_portable.zip",
    ]);
    expect(releaseFiles(dir).map((file) => file.name)).not.toContain(
      "OpenMind-Studio_1.0.3_windows_x86_portable.zip",
    );
    writeManifest(dir);
    expect(verifyManifest(dir)).toEqual([
      "windows/x64/OpenMind-Studio_1.0.3_windows_x86_portable.zip: in the wrong folder for its name",
    ]);
  });

  it("the release scripts write only into the project's release folder", () => {
    const script = (path: string) => readFileSync(join(root, path), "utf8");
    expect(script("scripts/release.mjs")).toContain("const out = releaseDir(root, version);");
    expect(script("scripts/package-portable.mjs")).toContain(
      'join("release", "staging", "portable")',
    );
    expect(script("scripts/linux-release.sh")).toContain(
      'out="$root/release/v$version/linux/$arch"',
    );
    expect(script("scripts/macos-release.sh")).toContain(
      'out="$root/release/v$version/macos/$arch"',
    );
    for (const path of ["scripts/linux-release.sh", "scripts/macos-release.sh"]) {
      expect(script(path)).not.toMatch(/git clone|cp -r .*src/);
    }
    const workflow = script(".github/workflows/release-windows.yml");
    expect(workflow).toContain("path: release/v*/");
    expect(workflow).toContain("path: release/v*/linux/");
    expect(workflow).toContain("path: release/v*/macos/");
    expect(script(".gitignore")).toMatch(/^\/release\/$/m);
  });
});
