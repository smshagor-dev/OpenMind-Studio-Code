/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  builtExe,
  PACKAGE_EXE,
  PACKAGE_FOLDER,
  readmeText,
  validateToolchainManifest,
  zipName,
} from "../../scripts/portablePackage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const text = (path: string) => readFileSync(join(root, path), "utf8");
const json = (path: string): Record<string, unknown> =>
  JSON.parse(text(path)) as Record<string, unknown>;

describe("portable package", () => {
  it("is named after the product and the version", () => {
    expect(PACKAGE_EXE).toBe("OpenMindStudio.exe");
    expect(PACKAGE_FOLDER).toBe("OpenMind Studio");
    expect(zipName("0.1.0")).toBe("OpenMindStudio-0.1.0-portable-win-x64.zip");
    expect(zipName("1.2.3-beta.1")).toBe("OpenMindStudio-1.2.3-beta.1-portable-win-x64.zip");
    expect(() => zipName("latest")).toThrow("not a version");
  });

  it("finds Cargo's output for a profile, wherever the target folder is", () => {
    expect(builtExe("C:/build/target", "release")).toBe(
      "C:/build/target/release/OpenMindStudio.exe",
    );
    expect(builtExe("E:\\t\\", "debug")).toBe("E:\\t/debug/OpenMindStudio.exe");
    expect(builtExe("t", "release", true)).toBe("t/release/openmind-studio.exe");
    expect(() => builtExe("t", "profiling")).toThrow("Unknown profile");
  });

  it("the README says everything stays in the folder and nothing touches AppData, the Registry or PATH", () => {
    const readme = readmeText("0.1.0");
    expect(readme).toContain("OpenMind Studio 0.1.0 — portable edition");
    for (const folder of ["data\\", "settings\\", "runtimes\\", "cache\\", "logs\\"]) {
      expect(readme).toContain(folder);
    }
    expect(readme).toMatch(/never in AppData,\s+the Registry or Program Files/);
    expect(readme).toContain("never changes your PATH");
    expect(readme).toContain("no administrator rights");
  });
});

describe("branding and packaging metadata agree", () => {
  const tauri = json("src-tauri/tauri.conf.json");
  const pkg = json("package.json");

  it("the product is OpenMind Studio everywhere the OS shows it", () => {
    expect(tauri.productName).toBe("OpenMind Studio");
    expect(tauri.mainBinaryName).toBe("OpenMindStudio");
    expect(tauri.identifier).toBe("com.openmindstudio.app");
    const windows = (tauri.app as { windows: { title: string }[] }).windows;
    expect(windows[0]?.title).toBe("OpenMind Studio");
    const bundle = tauri.bundle as { publisher: string; shortDescription: string };
    expect(bundle.publisher).toBe("OpenMind");
    expect(bundle.shortDescription).toContain("OpenMind Studio");
    expect(text("index.html")).toContain("<title>OpenMind Studio</title>");
  });

  it("the version is one number in package.json, tauri.conf.json and Cargo", () => {
    expect(tauri.version).toBe(pkg.version);
    expect(text("Cargo.toml")).toContain(`version = "${String(pkg.version)}"`);
  });

  it("the NSIS installer is per-user, so the app and its data folders never need administrator rights", () => {
    const bundle = tauri.bundle as {
      targets: string[];
      windows: { nsis: { installMode: string } };
    };
    expect(bundle.targets).toEqual(["nsis", "msi"]);
    expect(bundle.windows.nsis.installMode).toBe("currentUser");
  });

  it("the technical names stay lowercase-kebab", () => {
    expect(pkg.name).toBe("openmind-studio");
    expect(text("src-tauri/Cargo.toml")).toContain('name = "openmind-studio"');
  });

  it("every icon the bundle lists exists", () => {
    const icons = (tauri.bundle as { icon: string[] }).icon;
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(existsSync(join(root, "src-tauri", icon)), icon).toBe(true);
    }
  });
});

describe("tool bundle validation (packaging time only)", () => {
  const version = (v: string, extra: Record<string, unknown> = {}) => ({
    version: v,
    platform: "windows-x64",
    path: `tools/git/${v}/git.exe`,
    bundled: true,
    license: "GPL-2.0",
    ...extra,
  });
  const present = () => true;

  it("accepts a bundle whose files exist, with a licence note and at most five versions", () => {
    const manifest = {
      tools: [
        {
          id: "git",
          versions: ["2.47.0", "2.46.0", "2.45.0", "2.44.0", "2.43.0"].map((v) => version(v)),
        },
      ],
    };
    expect(validateToolchainManifest(manifest, present)).toEqual([]);
  });

  it("refuses more than five versions of one tool for the platform", () => {
    const six = ["6", "5", "4", "3", "2", "1"].map((n) => version(`1.${n}.0`));
    const problems = validateToolchainManifest({ tools: [{ id: "git", versions: six }] }, present);
    expect(problems).toEqual(["git: 6 versions for windows-x64; at most 5 are kept."]);
  });

  it("does not count versions for other platforms or that are not bundled", () => {
    const versions = [
      ...["1", "2", "3", "4", "5"].map((n) => version(`1.${n}.0`)),
      version("1.9.0", { platform: "linux-x64" }),
      version("1.8.0", { bundled: false }),
    ];
    expect(validateToolchainManifest({ tools: [{ id: "git", versions }] }, present)).toEqual([]);
  });

  it("refuses a listed file that is not in the bundle", () => {
    const problems = validateToolchainManifest(
      { tools: [{ id: "git", versions: [version("2.47.0")] }] },
      () => false,
    );
    expect(problems[0]).toContain("is listed but the file is not in the bundle");
  });

  it("refuses a version without a licence note: redistribution must have been checked", () => {
    const problems = validateToolchainManifest(
      { tools: [{ id: "git", versions: [version("2.47.0", { license: "" })] }] },
      present,
    );
    expect(problems[0]).toContain('no "license" note');
  });

  it("refuses paths that leave the app folder", () => {
    for (const path of ["../x/git.exe", "C:/git.exe", "/git.exe", "\\\\server\\git.exe", ""]) {
      const problems = validateToolchainManifest(
        { tools: [{ id: "git", versions: [version("2.47.0", { path })] }] },
        present,
      );
      expect(
        problems.some((p) => p.includes("must be relative")),
        path,
      ).toBe(true);
    }
  });

  it("refuses a manifest without a tools list", () => {
    expect(validateToolchainManifest({}, present)).toHaveLength(1);
    expect(validateToolchainManifest(null, present)).toHaveLength(1);
  });
});
