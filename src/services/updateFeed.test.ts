// The update feed (latest.json) the release writes and installed copies read.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  checkUpdaterConfig,
  compareVersions,
  latestJson,
  releaseDownloadUrl,
  signedVersion,
  UPDATE_ENDPOINT,
} from "../../scripts/releaseTools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string) => readFileSync(join(root, "src-tauri", "src", "updates", "fixtures", name), "utf8");
const tauri = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")) as Record<string, unknown>;

const signed = (kind: "setup" | "msi" | "portable", arch: "x64" | "x86", name: string) => ({
  kind,
  arch,
  name,
  signature: `sig-of-${name}`,
});

describe("the update feed (latest.json)", () => {
  const files = [
    signed("setup", "x64", "OpenMind-Studio-Setup-1.1.0-x64.exe"),
    signed("msi", "x64", "OpenMind-Studio-1.1.0-x64.msi"),
    signed("portable", "x64", "OpenMind-Studio-1.1.0-x64-portable.zip"),
    signed("setup", "x86", "OpenMind-Studio-Setup-1.1.0-x86.exe"),
    signed("msi", "x86", "OpenMind-Studio-1.1.0-x86.msi"),
  ];

  it("offers each architecture's setup, MSI and portable archive at the release's own addresses", () => {
    const feed = latestJson({ version: "1.1.0", notes: "n", pubDate: "2026-10-12T00:00:00Z", files });
    expect(Object.keys(feed.platforms).sort()).toEqual([
      "windows-i686",
      "windows-i686-msi",
      "windows-i686-nsis",
      "windows-x86_64",
      "windows-x86_64-msi",
      "windows-x86_64-nsis",
    ]);
    // A copy that isn't a known installer (portable, or an older build) reads the plain key: the setup.
    expect(feed.platforms["windows-x86_64"]?.url).toBe(
      releaseDownloadUrl("1.1.0", "OpenMind-Studio-Setup-1.1.0-x64.exe"),
    );
    expect(feed.platforms["windows-x86_64-msi"]?.url).toContain("/v1.1.0/OpenMind-Studio-1.1.0-x64.msi");
    expect(feed.openmind.portable["windows-x86_64"]?.signature).toBe("sig-of-OpenMind-Studio-1.1.0-x64-portable.zip");
    expect(feed.openmind.portable["windows-i686"]).toBeUndefined();
    expect(feed.openmind.channel).toBe("stable");
    expect(feed.openmind.minimumVersion).toBeUndefined();
    // Never a temporary or redirect address: always the tagged release download.
    for (const entry of Object.values(feed.platforms)) {
      expect(entry.url).toMatch(/^https:\/\/github\.com\/smshagor-dev\/OpenMind-Studio\/releases\/download\/v1\.1\.0\//);
    }
  });

  it("an architecture with only an MSI still answers copies that aren't installers", () => {
    const feed = latestJson({
      version: "1.1.0",
      notes: "",
      pubDate: "",
      files: [signed("msi", "x86", "OpenMind-Studio-1.1.0-x86.msi")],
    });
    expect(feed.platforms["windows-i686"]).toEqual(feed.platforms["windows-i686-msi"]);
  });

  it("a release can make older versions update, but never names a minimum newer than itself", () => {
    const feed = latestJson({ version: "1.2.0", notes: "", pubDate: "", minimumVersion: "1.1.0", files });
    expect(feed.openmind.minimumVersion).toBe("1.1.0");
    expect(() => latestJson({ version: "1.2.0", notes: "", pubDate: "", minimumVersion: "1.3.0", files })).toThrow(
      /newer than the release/,
    );
  });

  it("nothing unsigned, no pre-release and no unknown file goes into the feed", () => {
    expect(() =>
      latestJson({
        version: "1.1.0",
        notes: "",
        pubDate: "",
        files: [{ ...signed("setup", "x64", "a.exe"), signature: "  " }],
      }),
    ).toThrow(/no update signature/);
    expect(() => latestJson({ version: "1.1.0-beta.1", notes: "", pubDate: "", files })).toThrow(/pre-release/);
    expect(() => latestJson({ version: "1.1.0", notes: "", pubDate: "", files: [] })).toThrow(/at least one/);
    expect(() =>
      latestJson({ version: "1.1.0", notes: "", pubDate: "", files: [signed("portable", "x64", "p.zip")] }),
    ).toThrow(/at least one/);
  });

  it("reads the version a signature was bound to", () => {
    expect(signedVersion(fixture("payload.v1.2.3.sig"))).toBe("1.2.3");
    expect(signedVersion(fixture("payload.unversioned.sig"))).toBeNull();
  });

  it("compares versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.2", "1.0.2")).toBe(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
  });

  it("the app's updater points at the stable GitHub feed with the release key", () => {
    expect(checkUpdaterConfig(tauri)).toEqual([]);
    expect(UPDATE_ENDPOINT).toBe(
      "https://github.com/smshagor-dev/OpenMind-Studio/releases/latest/download/latest.json",
    );
  });
});
