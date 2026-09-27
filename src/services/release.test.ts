/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  checkInstallerConfig,
  checkWixSource,
  checksumsText,
  publicSigningInfo,
  readSigningConfig,
  redact,
  releaseName,
  reportText,
  signtoolArgs,
} from "../../scripts/releaseTools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const text = (path: string) => readFileSync(join(root, path), "utf8");
const tauri = JSON.parse(text("src-tauri/tauri.conf.json")) as Record<string, unknown>;

describe("installer and the Apache licence agreement", () => {
  it("the root LICENSE is the full Apache 2.0 text and the installers package it", () => {
    expect(existsSync(join(root, "LICENSE"))).toBe(true);
    expect(checkInstallerConfig(tauri, text("LICENSE"))).toEqual([]);
    const bundle = tauri.bundle as { licenseFile: string; license: string };
    expect(bundle.licenseFile).toBe("../LICENSE");
    expect(bundle.license).toBe("Apache-2.0");
  });

  it("a configuration that skips the licence, drops MSI or needs admin is reported", () => {
    const bad = { bundle: { targets: ["nsis"], windows: { nsis: { installMode: "perMachine" } } } };
    const problems = checkInstallerConfig(bad, "not a licence");
    expect(problems.join(" ")).toContain("licenseFile");
    expect(problems.join(" ")).toContain("msi");
    expect(problems.join(" ")).toContain("administrator");
    expect(problems.join(" ")).toContain("not the Apache");
    expect(problems.join(" ")).toContain("lsp-bundle");
  });

  it("the MSI source is checked: no PATH change, a licence page and a launch option", () => {
    const good =
      '<WixVariable Id="WixUILicenseRtf" Value="LICENSE.rtf"/><Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOX" Value="1"/>';
    expect(checkWixSource(good)).toEqual([]);
    expect(checkWixSource(`${good}<Environment Id="PATH" Name="PATH"/>`).join(" ")).toContain(
      "PATH",
    );
    expect(checkWixSource("<Wix/>")).toHaveLength(2);
  });

  it("no installer setting changes PATH or asks for admin rights beyond the per-user install", () => {
    const conf = text("src-tauri/tauri.conf.json").toLowerCase();
    expect(conf).not.toContain("permachine");
    expect(conf).not.toContain("hklm");
  });
});

describe("signing configuration", () => {
  it("nothing configured: an unsigned build with a clear message", () => {
    const config = readSigningConfig({});
    expect(config.mode).toBe("unsigned");
    expect(config.message).toContain("UNSIGNED");
  });

  it("a certificate without its password (or the reverse) is a clear misconfiguration, never a half-signed build", () => {
    expect(readSigningConfig({ SIGNING_CERT_PATH: "C:/c.pfx" }).message).toContain(
      "SIGNING_CERT_PASSWORD is missing",
    );
    expect(readSigningConfig({ SIGNING_CERT_PASSWORD: "x" }).message).toContain(
      "SIGNING_CERT_PATH is missing",
    );
    expect(readSigningConfig({ SIGNING_CERT_PATH: "C:/c.pfx" }).mode).toBe("misconfigured");
    expect(
      readSigningConfig({
        SIGNING_CERT_PATH: "a",
        SIGNING_CERT_PASSWORD: "b",
        TIMESTAMP_URL: "ftp://x",
      }).mode,
    ).toBe("misconfigured");
  });

  it("a real certificate is 'signed', a test certificate is marked 'test-signed'", () => {
    const env = {
      SIGNING_CERT_PATH: "C:/c.pfx",
      SIGNING_CERT_PASSWORD: "hunter2",
      TIMESTAMP_URL: "http://timestamp.example",
    };
    expect(readSigningConfig(env).mode).toBe("signed");
    expect(readSigningConfig({ ...env, SIGNING_CERT_KIND: "test" }).mode).toBe("test-signed");
    expect(readSigningConfig({ ...env, SIGNING_CERT_KIND: "test" }).message).toContain("TEST");
  });

  it("the password never appears in what is logged or written", () => {
    const config = readSigningConfig({
      SIGNING_CERT_PATH: "C:/secret path/c.pfx",
      SIGNING_CERT_PASSWORD: "hunter2",
    });
    const shown = JSON.stringify(publicSigningInfo(config)) + config.message;
    expect(shown).not.toContain("hunter2");
    expect(shown).not.toContain("secret path");
    expect(redact("signtool failed for /p hunter2 now", ["hunter2"])).toBe(
      "signtool failed for /p *** now",
    );
    expect(() => signtoolArgs(readSigningConfig({}), "a.exe")).toThrow();
    expect(signtoolArgs(config, "a.exe")).toEqual([
      "sign",
      "/fd",
      "SHA256",
      "/f",
      "C:/secret path/c.pfx",
      "/p",
      "hunter2",
      "a.exe",
    ]);
  });

  it("no certificate, key or password is committed to the repository", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const secretFiles = tracked.filter((file) => /\.(pfx|p12|pem|key|snk|cer)$/i.test(file));
    expect(secretFiles).toEqual([]);
    // This file is skipped: its fixtures use the obviously fake password "hunter2".
    const scanned = tracked.filter(
      (f) => /\.(mjs|ps1|json|md|yml|toml|ts|rs)$/.test(f) && f !== "src/services/release.test.ts",
    );
    for (const file of scanned) {
      if (!existsSync(join(root, file)) || statSync(join(root, file)).size > 400_000) continue;
      const content = readFileSync(join(root, file), "utf8");
      expect(content, file).not.toMatch(
        /SIGNING_CERT_PASSWORD\s*[=:]\s*["']?[A-Za-z0-9!@#$%^&*]{4,}/,
      );
    }
  });

  it("the signing scripts are the only place that reads the signing variables", () => {
    const users = readdirSync(join(root, "scripts")).filter((f) =>
      text(`scripts/${f}`).includes("SIGNING_CERT_PASSWORD"),
    );
    expect(users.sort()).toEqual(
      ["release.mjs", "releaseTools.d.mts", "releaseTools.mjs"].filter((f) => users.includes(f)),
    );
  });
});

describe("release artifacts", () => {
  it("uses the release names", () => {
    expect(releaseName("setup", "0.1.0")).toBe("OpenMind-Studio-Setup-0.1.0-x64.exe");
    expect(releaseName("msi", "0.1.0")).toBe("OpenMind-Studio-0.1.0-x64.msi");
    expect(releaseName("portable", "0.1.0")).toBe("OpenMind-Studio-Portable-0.1.0-x64.zip");
    expect(() => releaseName("setup", "v1")).toThrow();
  });

  it("the report lists only the files it was given, with type, size and SHA256; an empty list says so", () => {
    const artifacts = [
      {
        name: "OpenMind-Studio-Setup-0.1.0-x64.exe",
        kind: "setup",
        size: 7_500_000,
        sha256: "ab".repeat(32),
      },
    ];
    const report = reportText({
      version: "0.1.0",
      arch: "x64",
      buildType: "unsigned",
      date: "2026-09-30T00:00:00Z",
      artifacts,
    });
    expect(report).toContain("Setup-0.1.0-x64.exe");
    expect(report).toContain("7.2 MB");
    expect(report).toContain("ab".repeat(32));
    expect(report).toContain("**unsigned**");
    expect(report).not.toContain(".msi");
    expect(checksumsText(artifacts)).toBe(
      `${"ab".repeat(32)}  OpenMind-Studio-Setup-0.1.0-x64.exe\n`,
    );
    expect(
      reportText({
        version: "0.1.0",
        arch: "x64",
        buildType: "unsigned",
        date: "d",
        artifacts: [],
      }),
    ).toContain("No artifact was found");
  });
});
