/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  bundleManifest,
  compareWithLock,
  normalizeName,
  parseLock,
  parseWheelName,
  requirementsText,
  validatePythonBundle,
  type BundleConfig,
} from "../../scripts/pythonBundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = JSON.parse(
  readFileSync(join(root, "scripts/python-bundle/config.json"), "utf8"),
) as BundleConfig;
const lock = parseLock(readFileSync(join(root, "scripts/python-bundle/packages.lock"), "utf8"));

describe("offline Python package bundle", () => {
  it("covers 19 modules from Python itself (tkinter via Tcl/Tk) and 5 small, much-used packages", () => {
    expect(config.stdlib).toEqual([
      "os", "sys", "pathlib", "shutil", "subprocess", "json", "csv", "datetime", "time", "re", "logging", "asyncio",
      "sqlite3", "collections", "typing", "dataclasses", "random", "math", "tkinter",
    ]);
    expect(config.packages.map((p) => [p.name, p.import])).toEqual([
      ["requests", "requests"],
      ["httpx", "httpx"],
      ["python-dotenv", "dotenv"],
      ["python-telegram-bot", "telegram"],
      ["flask", "flask"],
    ]);
    expect(config.addon).toBe("tcltk");
    expect(config.python).toBe("3.14");
    // Every requested package is pinned in the lock, with its dependencies.
    const locked = new Set(lock.map((entry) => entry.name));
    for (const pkg of config.packages) expect(locked.has(pkg.name), pkg.name).toBe(true);
    expect(lock.every((entry) => /^\d/.test(entry.version))).toBe(true);
  });

  it("reads wheel names and compares the built wheels with the lock", () => {
    expect(parseWheelName("numpy-2.5.3-cp314-cp314-win_amd64.whl")).toEqual({ name: "numpy", version: "2.5.3" });
    expect(parseWheelName("python_dotenv-1.2.3-py3-none-any.whl")).toEqual({ name: "python-dotenv", version: "1.2.3" });
    expect(parseWheelName("opencv_python-5.0.0.93-cp37-abi3-win_amd64.whl")).toEqual({
      name: "opencv-python",
      version: "5.0.0.93",
    });
    expect(parseWheelName("pyaes-1.6.1.tar.gz")).toBeNull();
    expect(normalizeName("Typing_Extensions")).toBe("typing-extensions");
    const locked = [{ name: "numpy", version: "2.5.3" }, { name: "six", version: "1.17.0" }];
    expect(compareWithLock(locked, locked)).toEqual([]);
    expect(
      compareWithLock(locked, [{ name: "numpy", version: "2.5.4" }, { name: "evil", version: "1" }]).join(" | "),
    ).toBe("numpy: built 2.5.4, locked 2.5.3 | six==1.17.0: no wheel was built | evil: not in the lock");
  });

  it("pins every wheel with its hash and validates the finished bundle", () => {
    const wheels = [
      { name: "six", version: "1.17.0", sha256: "b".repeat(64) },
      { name: "numpy", version: "2.5.3", sha256: "a".repeat(64) },
    ];
    expect(requirementsText(wheels).split("\n").slice(1, 3)).toEqual([
      `numpy==2.5.3 --hash=sha256:${"a".repeat(64)}`,
      `six==1.17.0 --hash=sha256:${"b".repeat(64)}`,
    ]);
    const manifest = bundleManifest({
      config,
      wheels,
      zip: { sha256: "z".repeat(64), size: 10 },
      addon: { sha256: "t".repeat(64), url: "https://www.python.org/x/tcltk.msi" },
      createdAt: "2026-01-01T00:00:00Z",
    });
    const files: Record<string, string> = {
      "packages.zip": "z".repeat(64),
      "requirements.txt": "r",
      "tcltk.msi": "t".repeat(64),
    };
    expect(validatePythonBundle(manifest, config, (f) => files[f] ?? null)).toEqual([]);
    const tampered: Record<string, string> = { ...files, "packages.zip": "0".repeat(64) };
    expect(validatePythonBundle(manifest, config, (f) => tampered[f] ?? null).join(" ")).toContain(
      "does not match",
    );
    expect(validatePythonBundle(manifest, config, () => null).join(" ")).toContain("missing");
    expect(validatePythonBundle(null, config, () => null)[0]).toContain("not an OpenMind Python bundle");
  });

  it("ships with the installers and the portable package, and release builds check it", () => {
    const pkg = readFileSync(join(root, "package.json"), "utf8");
    expect(pkg).toContain('"python:bundle": "node scripts/prepare-python-bundle.mjs"');
    expect(pkg).toMatch(/"release:build": "[^"]*prepare-python-bundle\.mjs --check/);
    expect(readFileSync(join(root, "scripts/package-portable.mjs"), "utf8")).toContain('join(staging, "python-bundle")');
    const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")) as {
      bundle: { resources: Record<string, string> };
    };
    expect(tauri.bundle.resources["../python-bundle/"]).toBe("python-bundle/");
  });
});
