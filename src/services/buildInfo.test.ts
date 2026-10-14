import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { versionSources } from "../../scripts/buildInfo.mjs";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const files = (version: string, app = "version.workspace = true") => ({
  packageJson: JSON.stringify({ name: "x", version }),
  tauriConf: JSON.stringify({ version }),
  cargoToml: `[workspace]\nmembers = []\n\n[workspace.package]\nversion = "${version}"\nedition = "2021"\n\n[workspace.dependencies]\nfoo = { version = "9.9.9" }\n`,
  appCargoToml: `[package]\nname = "app"\n${app}\n\n[dependencies]\nbar = "1.0.0"\n`,
});

describe("build-info version", () => {
  it("reads the same version from every file, following version.workspace", () => {
    expect(versionSources(files("1.0.4")).map((s) => s.version)).toEqual(["1.0.4", "1.0.4", "1.0.4", "1.0.4"]);
  });

  it("reports the file that disagrees, never a dependency's version", () => {
    const changed = { ...files("1.0.4"), tauriConf: JSON.stringify({ version: "1.0.3" }) };
    expect(versionSources(changed).find((s) => s.file === "src-tauri/tauri.conf.json")?.version).toBe("1.0.3");
    const own = versionSources(files("1.0.4", 'version = "2.0.0"'));
    expect(own.find((s) => s.file === "src-tauri/Cargo.toml")?.version).toBe("2.0.0");
    const none = versionSources({ ...files("1.0.4"), cargoToml: "[workspace]\n" });
    expect(none.find((s) => s.file === "Cargo.toml")?.version).toBeNull();
  });

  it("agrees on this repository's version and the command line says so", () => {
    const real = versionSources({
      packageJson: read("package.json"),
      tauriConf: read("src-tauri/tauri.conf.json"),
      cargoToml: read("Cargo.toml"),
      appCargoToml: read("src-tauri/Cargo.toml"),
    });
    const { version } = JSON.parse(read("package.json")) as { version: string };
    expect(real.every((s) => s.version === version)).toBe(true);
    const printed = execFileSync(process.execPath, [join(root, "scripts", "build-info.mjs"), "version", "--expect", version], {
      encoding: "utf8",
    });
    expect(printed.trim()).toBe(version);
    expect(() =>
      execFileSync(process.execPath, [join(root, "scripts", "build-info.mjs"), "version", "--expect", "0.0.0"], {
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
