/// <reference types="node" />
// The OpenMind Studio legal texts (docs/legal/, shipped as legal/ and shown by the installers), the platform launchers
// (scripts/launchers/) and the macOS architecture check of the release verifier.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  agreementText,
  checkAgreement,
  LEGAL_FILES,
  markdownToText,
} from "../../scripts/legalTexts.mjs";
import { machoArches } from "../../scripts/verify-architecture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const text = (path: string) => readFileSync(join(root, path), "utf8");
const eula = text("docs/legal/eula.md");
const privacy = text("docs/legal/privacy-policy.md");
/** The policy with line breaks folded, so phrases are found wherever the text wraps. */
const privacyText = privacy.replace(/\s+/g, " ");
const terms = text("docs/legal/terms-of-use.md");
const license = text("LICENSE");

describe("legal texts", () => {
  it("the installer agreement holds the License Agreement, the Privacy Policy and the full Apache 2.0 text", () => {
    const agreement = agreementText({ eula, privacy, license });
    expect(checkAgreement(agreement)).toEqual([]);
    expect(agreement.indexOf("OPENMIND STUDIO LICENSE AGREEMENT")).toBeLessThan(
      agreement.indexOf("OPENMIND STUDIO PRIVACY POLICY"),
    );
    expect(agreement.indexOf("OPENMIND STUDIO PRIVACY POLICY")).toBeLessThan(
      agreement.indexOf("END OF TERMS AND CONDITIONS"),
    );
    // Privacy acknowledgement is not consent: the agreement says so up front.
    expect(agreement).toContain("does not turn on any optional feature");
    expect(checkAgreement(agreementText({ eula, privacy: "", license })).join(" ")).toContain(
      "Privacy Policy",
    );
    expect(checkAgreement(agreementText({ eula: "", privacy, license })).join(" ")).toContain(
      "EULA",
    );
  });

  it("Markdown becomes plain text for the installers' text boxes", () => {
    expect(
      markdownToText("# Title\n\nA **bold\nspan** and [link](https://x.org) <https://y.org>\n"),
    ).toBe("TITLE\n=====\n\nA bold\nspan and link (https://x.org) https://y.org\n");
    expect(markdownToText("| A | B |\n| --- | --- |\n| 1 | 2 |\n")).toBe("A - B\n1 - 2\n");
  });

  it("the privacy policy states what really leaves the computer and claims nothing it can't back up", () => {
    // The automatic requests, named with their service.
    expect(privacyText).toContain("releases/latest/download/latest.json");
    expect(privacyText).toContain("open-vsx.org");
    expect(privacyText).toContain("The check itself cannot currently be turned off");
    // Honest about platforms and encryption.
    expect(privacyText).toContain("On Linux and macOS this encryption is not available yet");
    expect(privacyText).not.toMatch(/end-to-end encrypt/i);
    expect(privacyText).not.toMatch(/nothing (ever )?leaves your computer/i);
    expect(privacyText).toContain("smshagor.dev@gmail.com");
  });

  it("the license agreement adds nothing that would contradict the Apache License", () => {
    expect(eula).toContain("Apache License, Version 2.0");
    expect(eula).toContain("Nothing in this agreement limits");
    expect(eula).not.toMatch(/you may not (copy|modify|distribute|reverse)/i);
    expect(terms).toContain("SHA256SUMS.txt");
  });

  it("every package ships the same legal files", () => {
    expect(Object.keys(LEGAL_FILES).sort()).toEqual([
      "EULA.md",
      "LICENSE-AGREEMENT.txt",
      "LICENSE.txt",
      "PRIVACY-POLICY.md",
      "TERMS-OF-USE.md",
    ]);
    const tauri = JSON.parse(text("src-tauri/tauri.conf.json")) as {
      bundle: { resources: Record<string, string> };
    };
    expect(tauri.bundle.resources["../licenses/legal/"]).toBe("legal/");
    expect(text("scripts/package-portable.mjs")).toContain('join(staging, "legal")');
    expect(text("scripts/linux-release.sh")).toContain('"$stage/OpenMind Studio/legal/"');
    expect(text("scripts/macos-release.sh")).toContain('"$stage/OpenMind Studio/legal/"');
    expect(text("package.json")).toContain("node scripts/legal-texts.mjs --check");
  });
});

describe("launchers", () => {
  const bat = text("scripts/launchers/windows/Start OpenMind Studio.bat");
  const sh = text("scripts/launchers/linux/openmind-studio.sh");
  const command = text("scripts/launchers/macos/Start OpenMind Studio.command");

  it("the Windows launcher starts the program next to itself, in its folder, and explains a missing program", () => {
    expect(bat).toContain('set "OM_DIR=%~dp0"');
    expect(bat).toContain('start "OpenMind Studio" /D "%OM_DIR%" "%OM_EXE%" %*');
    expect(bat).toContain('if not exist "%OM_EXE%"');
    expect(bat).not.toMatch(/runas|[A-Z]:\\(Users|Program)/i);
  });

  it("the Linux launcher checks the architecture and missing libraries, and never needs sudo to start", () => {
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain('dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)');
    expect(sh).toContain("ldd");
    expect(sh).toContain('exec "$program" "$@"');
    expect(sh).not.toMatch(/^\s*sudo /m);
  });

  it("the macOS launcher opens the app bundle, checks its architecture and never touches Gatekeeper", () => {
    expect(command.startsWith("#!/bin/sh\n")).toBe(true);
    expect(command).toContain('app="$dir/OpenMind Studio.app"');
    expect(command).toContain("lipo -archs");
    expect(command).not.toMatch(/xattr\s+-(d|c|r)|spctl\s+--master-disable|--add/);
  });

  it("line endings: CRLF for the batch file, LF for the shell scripts (.gitattributes)", () => {
    const attributes = text(".gitattributes");
    expect(attributes).toContain("scripts/launchers/**/*.bat text eol=crlf");
    expect(attributes).toContain("scripts/launchers/**/*.command text eol=lf");
    expect(sh).not.toContain("\r");
    expect(command).not.toContain("\r");
  });
});

describe("Mach-O architecture of the macOS app", () => {
  const thin = (cpu: number) => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(0xcffaedfe, 0);
    bytes.writeUInt32LE(cpu, 4);
    return bytes;
  };

  it("reads thin and universal binaries", () => {
    expect(machoArches(thin(0x0100000c))).toEqual(["arm64"]);
    expect(machoArches(thin(0x01000007))).toEqual(["x64"]);
    const fat = Buffer.alloc(8 + 2 * 20);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x01000007, 8);
    fat.writeUInt32BE(0x0100000c, 28);
    expect(machoArches(fat)).toEqual(["x64", "arm64"]);
    expect(machoArches(Buffer.from("\x7fELF0000000000000000000000000000", "latin1"))).toEqual([]);
  });
});
