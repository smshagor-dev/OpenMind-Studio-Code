/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  checkInstallerConfig,
  checkInstallerHooks,
  checkWixSource,
  checksumsText,
  publicSigningInfo,
  readSigningConfig,
  signatureVerdict,
  redact,
  releaseDir,
  releaseKindOf,
  releaseName,
  releaseArch,
  releaseArchOf,
  releasePlatform,
  releaseSubdir,
  reportText,
} from "../../scripts/releaseTools.mjs";
import { signtoolSignArgs } from "../../scripts/authenticodeTools.mjs";
import { agreementText } from "../../scripts/legalTexts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const text = (path: string) => readFileSync(join(root, path), "utf8");
const tauri = JSON.parse(text("src-tauri/tauri.conf.json")) as Record<string, unknown>;
/** The installers' agreement as scripts/legal-texts.mjs builds it (the generated file may not exist before pnpm build). */
const agreement = () =>
  agreementText({
    eula: text("docs/legal/eula.md"),
    privacy: text("docs/legal/privacy-policy.md"),
    license: text("LICENSE"),
  });

describe("installer and the Apache licence agreement", () => {
  it("the installers show the License Agreement, the Privacy Policy and the full Apache 2.0 text", () => {
    expect(existsSync(join(root, "LICENSE"))).toBe(true);
    expect(checkInstallerConfig(tauri, agreement())).toEqual([]);
    // The bare Apache text alone is no longer enough: the agreement must carry the EULA and the Privacy Policy.
    expect(checkInstallerConfig(tauri, text("LICENSE")).join(" ")).toContain("Privacy Policy");
    const bundle = tauri.bundle as { licenseFile: string; license: string };
    expect(bundle.licenseFile).toBe("../licenses/legal/LICENSE-AGREEMENT.txt");
    expect(bundle.license).toBe("Apache-2.0");
  });

  it("a configuration that skips the licence, drops MSI or needs admin is reported", () => {
    const bad = { bundle: { targets: ["nsis"], windows: { nsis: { installMode: "perMachine" } } } };
    const problems = checkInstallerConfig(bad, "not a licence");
    expect(problems.join(" ")).toContain("licenseFile");
    expect(problems.join(" ")).toContain("msi");
    expect(problems.join(" ")).toContain("administrator");
    expect(problems.join(" ")).toContain("Apache License 2.0 text");
    expect(problems.join(" ")).toContain("lsp-bundle");
  });

  it("the MSI source is checked: no PATH change, a licence page and a launch option", () => {
    const good =
      '<WixVariable Id="WixUILicenseRtf" Value="LICENSE.rtf"/><Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOX" Value="1"/><Icon Id="OpenMindStudioIcon" SourceFile="icons/icon.ico"/><Property Id="ARPPRODUCTICON" Value="OpenMindStudioIcon"/>';
    expect(checkWixSource(good)).toEqual([]);
    expect(checkWixSource(`${good}<Environment Id="PATH" Name="PATH"/>`).join(" ")).toContain(
      "PATH",
    );
    expect(checkWixSource("<Wix/>")).toHaveLength(3);
  });

  it("the installer artwork is 24-bit BMP at the sizes NSIS and WiX expect", () => {
    const windows = (
      tauri.bundle as {
        windows: {
          nsis: {
            headerImage: string;
            sidebarImage: string;
            installerIcon: string;
            uninstallerIcon: string;
          };
          wix: { bannerPath: string; dialogImagePath: string };
        };
      }
    ).windows;
    const expected: [string, number, number][] = [
      [windows.nsis.headerImage, 150, 57],
      [windows.nsis.sidebarImage, 164, 314],
      [windows.wix.bannerPath, 493, 58],
      [windows.wix.dialogImagePath, 493, 312],
    ];
    for (const [path, width, height] of expected) {
      const bmp = readFileSync(join(root, "src-tauri", path));
      expect(bmp.toString("latin1", 0, 2), path).toBe("BM");
      expect(bmp.readInt32LE(18), path).toBe(width);
      expect(Math.abs(bmp.readInt32LE(22)), path).toBe(height);
      expect(bmp.readUInt16LE(28), path).toBe(24);
    }
    expect(existsSync(join(root, "src-tauri", windows.nsis.installerIcon))).toBe(true);
    expect(windows.nsis.uninstallerIcon).toBe("icons/icon.ico");
    expect(existsSync(join(root, "src-tauri", windows.nsis.uninstallerIcon))).toBe(true);
  });

  it("the app and installer product icons are pinned to the custom icon", () => {
    const bundle = tauri.bundle as {
      icon: string[];
      windows: {
        nsis: { installerIcon: string; uninstallerIcon: string };
        wix: { fragmentPaths: string[] };
      };
    };
    expect(bundle.icon).toContain("icons/icon.ico");
    expect(bundle.windows.nsis.installerIcon).toBe("icons/icon.ico");
    expect(bundle.windows.nsis.uninstallerIcon).toBe("icons/icon.ico");
    expect(bundle.windows.wix.fragmentPaths).toContain("wix/product-icon.wxs");
    const fragment = text("src-tauri/wix/product-icon.wxs");
    expect(fragment).toContain('SourceFile="icons/icon.ico"');
    expect(fragment).toContain("ARPPRODUCTICON");
  });

  it("no installer setting changes PATH or asks for admin rights beyond the per-user install", () => {
    const conf = text("src-tauri/tauri.conf.json").toLowerCase();
    expect(conf).not.toContain("permachine");
    expect(conf).not.toContain("hklm");
  });
});

describe("optional PATH and File Explorer integration in the installers", () => {
  const license = agreement();
  const hooks = text("src-tauri/nsis/installer-hooks.nsh");
  const fragment = text("src-tauri/wix/integration.wxs");

  it("the installers are configured with the hooks, the MSI components and the bin launchers", () => {
    expect(checkInstallerConfig(tauri, license)).toEqual([]);
    const bundle = tauri.bundle as {
      windows: Record<string, Record<string, unknown>>;
      resources: Record<string, string>;
    };
    const without = {
      ...tauri,
      bundle: {
        ...bundle,
        windows: { ...bundle.windows, nsis: { ...bundle.windows.nsis, installerHooks: undefined } },
        resources: { "../lsp-bundle/": "lsp/" },
      },
    };
    const problems = checkInstallerConfig(without, license).join(" ");
    expect(problems).toContain("installer-hooks.nsh");
    expect(problems).toContain("bin/openmind.cmd");
  });

  it("every package ships the shared-installation deployment package next to the program", () => {
    const bundle = tauri.bundle as { resources: Record<string, string> };
    expect(bundle.resources["deploy/"]).toBe("deploy/");
    const without = { ...tauri, bundle: { ...bundle, resources: { ...bundle.resources, "deploy/": undefined } } };
    expect(checkInstallerConfig(without, license).join(" ")).toContain('"deploy/"');
    expect(text("scripts/package-portable.mjs")).toContain('join(root, "src-tauri", "deploy")');
    const files = readdirSync(join(root, "src-tauri", "deploy")).sort();
    expect(files).toEqual([
      "Check Installation.cmd",
      "Create Desktop Shortcut.cmd",
      "OpenMindStudio-Logon.cmd",
      "README.txt",
      "Remove Desktop Shortcut.cmd",
    ]);
    const actions: Record<string, string> = {
      "Check Installation.cmd": "--integration check",
      "Create Desktop Shortcut.cmd": "--integration desktop-shortcut",
      "Remove Desktop Shortcut.cmd": "--integration remove-desktop-shortcut",
      "OpenMindStudio-Logon.cmd": "--integration %OM_ACTION%",
    };
    for (const [name, action] of Object.entries(actions)) {
      const script = text(`src-tauri/deploy/${name}`);
      // Batch files with LF endings mis-jump to labels; the program is found next to the deploy folder, never by PATH.
      expect(script.replace(/\r\n/g, "").includes("\n"), name).toBe(false);
      expect(script, name).toContain('set "OM_EXE=%~dp0..\\OpenMindStudio.exe"');
      expect(script, name).toContain(action);
      // A ")" in a path (Program Files (x86)) would end a parenthesised block: paths are echoed outside blocks only.
      expect(/\([^)]*%OM_EXE%/.test(script), name).toBe(false);
      // Nothing is elevated, installed system-wide or forced past a policy.
      expect(script.toLowerCase(), name).not.toMatch(/runas|--all-users|reg add|set-executionpolicy|bypass/);
    }
    const logon = text("src-tauri/deploy/OpenMindStudio-Logon.cmd");
    expect(logon).toContain('if /i "%~1"=="remove" set "OM_ACTION=remove-desktop-shortcut"');
    expect(logon.match(/exit \/b (\d+)/g)).toEqual(["exit /b 0", "exit /b 0"]);
    expect(logon).not.toContain("pause");
  });

  it("the license agreement must be accepted with an unchecked check box, never radio buttons", () => {
    expect(hooks).toMatch(/^!define MUI_LICENSEPAGE_CHECKBOX$/m);
    expect(hooks).toMatch(/MUI_LICENSEPAGE_CHECKBOX_TEXT "I accept the OpenMind Studio License Agreement"/);
    const without = hooks.replace(/^!define MUI_LICENSEPAGE_CHECKBOX$/m, "");
    expect(checkInstallerHooks(without).join(" ")).toContain("unchecked check box");
    expect(checkInstallerHooks(`${hooks}\n!define MUI_LICENSEPAGE_RADIOBUTTONS`).join(" ")).toContain(
      "radio buttons",
    );
  });

  it("the NSIS check boxes start unchecked, run the app's --integration actions and are undone on uninstall", () => {
    expect(checkInstallerHooks(hooks)).toEqual([]);
    expect(hooks).toMatch(/!define MUI_PAGE_CUSTOMFUNCTION_SHOW OmWelcomeShow/);
    const checkedByDefault = hooks.replace("StrCpy $OmAddPath 0", "StrCpy $OmAddPath 1");
    expect(checkInstallerHooks(checkedByDefault).join(" ")).toContain("unchecked");
    const noUninstall = hooks.replaceAll("--integration remove-all", "--integration status");
    expect(checkInstallerHooks(noUninstall).join(" ")).toContain("remove-all");
    const writesRegistry = `${hooks}\nWriteRegExpandStr HKCU "Environment" "Path" "x"`;
    expect(checkInstallerHooks(writesRegistry).join(" ")).toContain("must not write");
  });

  it("the setup records how it installed the program: For Me, or Recommended for All Users (a network folder)", () => {
    // The visible labels, exactly; the stored values stay `per-user` / `network` (older installs keep their choice).
    expect(hooks).toContain('${NSD_CreateFirstRadioButton} 128u 135u 187u 11u "For Me"');
    expect(hooks).toContain('${NSD_CreateRadioButton} 128u 147u 187u 11u "Recommended for All Users"');
    expect(hooks).not.toMatch(/All connected PCs/i);
    expect(hooks).toContain("--integration set-layout per-user");
    // "For Me" is the default; the network choice comes from the page, /NETWORK or an earlier network install.
    expect(hooks).toMatch(/\$\{NSD_Check\} \$OmMeRadio/);
    expect(hooks).toMatch(/\$\{GetOptions\} \$CMDLINE "\/NETWORK"/);
    expect(hooks).toMatch(/FileOpen \$0 "\$INSTDIR\\install\.json" r/);
    const noLayout = hooks.replaceAll("--integration set-layout network", "--integration status");
    expect(checkInstallerHooks(noLayout).join(" ")).toContain("set-layout network");
    const noSwitch = hooks.replaceAll('"/NETWORK"', '"/OTHER"');
    expect(checkInstallerHooks(noSwitch).join(" ")).toContain("/NETWORK");
    // The record goes with the program on uninstall, never on an update.
    expect(hooks).toMatch(/\$UpdateMode <> 1[\s\S]*Delete "\$INSTDIR\\install\.json"/);
  });

  it("a network installation's Desktop shortcuts: per-user at first start unless declined, never re-added on update", () => {
    const post = hooks.slice(hooks.indexOf("!macro NSIS_HOOK_POSTINSTALL"), hooks.indexOf("!macro NSIS_HOOK_PREUNINSTALL"));
    // On by default; /NOUSERSHORTCUTS or "No" on the page turns it off, recorded once, on a fresh install only.
    expect(hooks).toContain("StrCpy $OmUserShortcuts 1");
    expect(hooks).toMatch(/\$\{GetOptions\} \$CMDLINE "\/NOUSERSHORTCUTS" \$0\s+\$\{IfNot\} \$\{Errors\}\s+StrCpy \$OmUserShortcuts 0/);
    expect(hooks).toMatch(/MessageBox MB_YESNO\|MB_ICONQUESTION "Recommended for All Users[^"]*Desktop[^"]*" IDYES/);
    expect(post).toMatch(/\$OmState == "fresh"\s+\$\{AndIf\} \$OmUserShortcuts == 0\s+ExecWait '[^']*--integration user-desktop-shortcuts off'/);
    // The installing user's own shortcut: the finish page decides; silent/passive installs get the network path, but
    // never on an update or with /NS, so a deleted shortcut stays deleted.
    expect(post).toMatch(
      /\$UpdateMode <> 1\s+\$\{AndIf\} \$NoShortcutMode <> 1\s+\$\{If\} \$\{Silent\}\s+\$\{OrIf\} \$PassiveMode = 1\s+ExecWait '[^']*--integration desktop-shortcut'/,
    );
    expect(post.match(/--integration desktop-shortcut'/g)).toHaveLength(1);
  });

  it("an existing installation is updated in place: no second install, no downgrade, never while in use", () => {
    expect(checkInstallerHooks(hooks)).toEqual([]);
    const conf = tauri.bundle as { windows: Record<string, unknown> };
    expect(conf.windows.allowDowngrades).toBe(false);
    const downgrades = {
      ...tauri,
      bundle: { ...(tauri.bundle as object), windows: { ...conf.windows, allowDowngrades: true } },
    };
    expect(checkInstallerConfig(downgrades, license).join(" ")).toContain("allowDowngrades");
    // The update page replaces the installation type choice, and the button says what happens.
    expect(hooks).toContain('"STR:OpenMind Studio Update"');
    expect(hooks).toContain('Push "Update OpenMind Studio"');
    expect(hooks).toContain('Push "Repair OpenMind Studio"');
    // Found where installed copies noted themselves (a shared folder someone else installed).
    expect(hooks).toContain('!define OM_INSTALLATIONS_KEY "Software\\OpenMind\\OpenMind Studio Installations"');
    const fresh = hooks.replace("Call OmUpdatePage", "Call OmNothing");
    expect(checkInstallerHooks(fresh).join(" ")).toContain("Update page");
    const reinstalls = hooks.replace("StrCpy $UpdateMode 1", "StrCpy $UpdateMode 0");
    expect(checkInstallerHooks(reinstalls).join(" ")).toContain("in place");
    const downgradeOk = hooks.replaceAll('"/ALLOWDOWNGRADE"', '"/X"');
    expect(checkInstallerHooks(downgradeOk).join(" ")).toContain("newer installation");
    const unlocked = hooks.replace(/Call OmClaim\r?\n(?![\s\S]*Call OmClaim)/, "\n");
    expect(checkInstallerHooks(unlocked).join(" ")).toContain("not in use");
    const kills = `${hooks}\nnsis_tauri_utils::KillProcessCurrentUser "OpenMindStudio.exe"`;
    expect(checkInstallerHooks(kills).join(" ")).toContain("never close");
    // The MSI stops when the per-user setup already installed OpenMind Studio for this user.
    expect(fragment).toContain("<Condition Message=");
    expect(fragment).toContain("Installed OR NOT OM_NSIS_INSTALL");
  });

  it("the MSI changes PATH only through ADDTOPATH and adds Explorer entries only with EXPLORERMENU", () => {
    expect(fragment).toMatch(/<Condition>ADDTOPATH = "1"<\/Condition>/);
    expect(fragment).toMatch(/<Condition>EXPLORERMENU = "1"<\/Condition>/);
    expect(fragment).toContain(
      'Value="[INSTALLDIR]bin" Part="last" Action="set" System="yes" Permanent="no"',
    );
    expect(fragment).toContain("&quot;[INSTALLDIR]OpenMindStudio.exe&quot; &quot;%V&quot;");
    expect(fragment).toContain("&quot;[INSTALLDIR]OpenMindStudio.exe&quot; &quot;%1&quot;");
    const rest =
      '<WixVariable Id="WixUILicenseRtf" Value="LICENSE.rtf"/><Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOX" Value="1"/><Icon Id="I" SourceFile="icons/icon.ico"/><Property Id="ARPPRODUCTICON" Value="I"/>';
    expect(checkWixSource(`${rest}${fragment}`)).toEqual([]);
    const always = fragment.replace('<Condition>ADDTOPATH = "1"</Condition>', "");
    expect(checkWixSource(`${rest}${always}`).join(" ")).toContain("ADDTOPATH");
    const permanent = fragment.replace('Permanent="no"', 'Permanent="yes"');
    expect(checkWixSource(`${rest}${permanent}`).join(" ")).toContain("ADDTOPATH");
  });

  it("the shipped launcher calls the program beside bin and the docs describe the options", () => {
    expect(text("src-tauri/cli/openmind.cmd")).toContain(
      'start "" "%~dp0..\\OpenMindStudio.exe" %*',
    );
    const doc = text("docs/installer.md");
    for (const phrase of [
      "/ADDTOPATH",
      "/EXPLORERMENU",
      "ADDTOPATH=1",
      "EXPLORERMENU=1",
      "portable",
      "new terminal",
    ]) {
      expect(doc).toContain(phrase);
    }
    expect(text("docs/release.md")).toContain("docs/installer.md");
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

  it("a certificate from the Windows store is chosen by thumbprint, with no password", () => {
    const thumbprint = "352ED3665AF5E1E59278F1E7ABF463F9BA4FE8EC";
    const config = readSigningConfig({
      SIGNING_CERT_THUMBPRINT: ` ${thumbprint.toLowerCase()} `,
      SIGNING_CERT_KIND: "test",
      TIMESTAMP_URL: "http://timestamp.example",
    });
    expect(config.mode).toBe("test-signed");
    expect(config.thumbprint).toBe(thumbprint);
    expect(signtoolSignArgs({ thumbprint, timestampUrl: config.timestampUrl }, "a.exe")).toEqual([
      "sign",
      "/fd",
      "SHA256",
      "/sha1",
      thumbprint,
      "/s",
      "My",
      "/tr",
      "http://timestamp.example",
      "/td",
      "SHA256",
      "/d",
      "OpenMind Studio",
      "a.exe",
    ]);
    expect(readSigningConfig({ SIGNING_CERT_THUMBPRINT: "abc" }).mode).toBe("misconfigured");
    expect(
      readSigningConfig({ SIGNING_CERT_THUMBPRINT: thumbprint, TIMESTAMP_URL: "ftp://x" }).mode,
    ).toBe("misconfigured");
  });

  it("a release certificate needs an RFC 3161 timestamp server unless that is explicitly waived", () => {
    const pfx = { SIGNING_CERT_PATH: "C:/c.pfx", SIGNING_CERT_PASSWORD: "hunter2" };
    const store = { SIGNING_CERT_THUMBPRINT: "352ED3665AF5E1E59278F1E7ABF463F9BA4FE8EC" };
    for (const env of [pfx, store]) {
      const without = readSigningConfig(env);
      expect(without.mode).toBe("misconfigured");
      expect(without.message).toContain("TIMESTAMP_URL");
      expect(readSigningConfig({ ...env, SIGNING_NO_TIMESTAMP: "1" }).mode).toBe("signed");
      expect(readSigningConfig({ ...env, TIMESTAMP_URL: "http://ts.example" }).mode).toBe("signed");
      // A test certificate (development) may go without.
      expect(readSigningConfig({ ...env, SIGNING_CERT_KIND: "test" }).mode).toBe("test-signed");
    }
  });

  it("only a valid, timestamped signature passes for a release; a test one needs to be intact", () => {
    const valid = { status: "Valid", signer: "CN=OpenMind", timestamped: true, timestamper: "CN=TSA" };
    expect(signatureVerdict(valid, "signed")).toBeNull();
    expect(signatureVerdict(valid, "external")).toBeNull();
    expect(signatureVerdict({ ...valid, timestamped: false }, "signed")).toContain("timestamp");
    expect(signatureVerdict({ ...valid, timestamped: false }, "signed", { timestampWaived: true })).toBeNull();
    expect(signatureVerdict({ ...valid, status: "NotTrusted" }, "signed")).toContain("NotTrusted");
    expect(signatureVerdict({ ...valid, status: "NotTrusted" }, "test-signed")).toBeNull();
    expect(signatureVerdict({ ...valid, status: "HashMismatch" }, "test-signed")).toContain("changed");
    expect(signatureVerdict({ ...valid, status: "NotSigned", signer: null }, "signed")).toBe("not signed");
    expect(signatureVerdict(null, "test-signed")).toBe("not signed");
  });

  it("the password never appears in what is logged or written", () => {
    const config = readSigningConfig({
      SIGNING_CERT_PATH: "C:/secret path/c.pfx",
      SIGNING_CERT_PASSWORD: "hunter2",
      SIGNING_NO_TIMESTAMP: "1",
    });
    const shown = JSON.stringify(publicSigningInfo(config)) + config.message;
    expect(shown).not.toContain("hunter2");
    expect(shown).not.toContain("secret path");
    expect(redact("signtool failed for /p hunter2 now", ["hunter2"])).toBe(
      "signtool failed for /p *** now",
    );
    // SignTool is only ever given a thumbprint: a PFX configuration has none until it is imported into the store
    // (scripts/signtool.mjs withCertificate), so its password can't reach a command line.
    expect(config.mode).toBe("signed");
    expect(() => signtoolSignArgs({ thumbprint: (config as { thumbprint?: string }).thumbprint }, "a.exe")).toThrow(
      "thumbprint",
    );
    const args = signtoolSignArgs({ thumbprint: "352ED3665AF5E1E59278F1E7ABF463F9BA4FE8EC" }, "a.exe");
    expect(args.join(" ")).not.toContain("hunter2");
    expect(args).not.toContain("/p");
    expect(args).not.toContain("/f");
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
    const users = readdirSync(join(root, "scripts"))
      .filter((f) => statSync(join(root, "scripts", f)).isFile())
      .filter((f) => text(`scripts/${f}`).includes("SIGNING_CERT_PASSWORD"));
    expect(users.sort()).toEqual(
      ["release.mjs", "releaseTools.d.mts", "releaseTools.mjs"].filter((f) => users.includes(f)),
    );
  });
});

describe("release artifacts", () => {
  it("uses the release names", () => {
    expect(releaseName("setup", "1.0.3")).toBe("OpenMind-Studio_1.0.3_windows_x64_setup.exe");
    expect(releaseName("msi", "1.0.3")).toBe("OpenMind-Studio_1.0.3_windows_x64.msi");
    expect(releaseName("portable", "1.0.3")).toBe("OpenMind-Studio_1.0.3_windows_x64_portable.zip");
    expect(releaseName("setup", "1.0.3", "x86")).toBe("OpenMind-Studio_1.0.3_windows_x86_setup.exe");
    // Debian/Rust spellings of the architecture give the same names.
    expect(releaseName("deb", "1.0.3", "amd64")).toBe("OpenMind-Studio_1.0.3_linux_x64.deb");
    expect(releaseName("appimage", "1.0.3", "x86_64")).toBe("OpenMind-Studio_1.0.3_linux_x64.AppImage");
    expect(releaseName("deb", "1.0.3", "i386")).toBe("OpenMind-Studio_1.0.3_linux_x86.deb");
    expect(releaseName("linux-portable", "1.0.3", "i686")).toBe(
      "OpenMind-Studio_1.0.3_linux_x86_portable.tar.gz",
    );
    expect(() => releaseName("setup", "v1")).toThrow();
    expect(() => releaseName("setup", "1.0.3", "arm64")).toThrow();
    // @ts-expect-error -- an unknown kind is refused at run time too
    expect(() => releaseName("installer", "1.0.3")).toThrow();
  });

  it("puts each kind into its platform folder of the project's release folder, and reads kinds back from names", () => {
    expect(releaseDir("E:/Code Editor", "1.0.3")).toBe("E:/Code Editor/release/v1.0.3");
    expect(releaseDir("E:/Code Editor/", "1.0.3")).toBe("E:/Code Editor/release/v1.0.3");
    expect(() => releaseDir("E:/Code Editor", "../x")).toThrow();
    for (const kind of ["setup", "msi", "portable"]) expect(releasePlatform(kind)).toBe("windows");
    for (const kind of ["deb", "appimage", "linux-portable"]) expect(releasePlatform(kind)).toBe("linux");
    for (const kind of ["setup", "msi", "portable", "deb", "appimage", "linux-portable"] as const) {
      for (const arch of ["x64", "x86"]) expect(releaseKindOf(releaseName(kind, "1.0.3", arch))).toBe(kind);
    }
    expect(releaseKindOf("OpenMind-Studio_1.0.3_windows_x64_setup.exe.sig")).toBeNull();
    expect(releaseKindOf("RELEASE-NOTES-1.0.3-DRAFT.md")).toBeNull();
    expect(releaseKindOf("OpenMindStudio-1.0.3-portable-win-x64.zip")).toBeNull();
  });

  it("macOS is released for arm64 and x64, and every file goes into <platform>/<arch>/", () => {
    for (const kind of ["dmg", "macos-app"] as const) {
      expect(releasePlatform(kind)).toBe("macos");
      for (const arch of ["arm64", "aarch64", "x64", "x86_64"]) {
        const name = releaseName(kind, "1.0.3", arch);
        expect(releaseKindOf(name)).toBe(kind);
        expect(releaseSubdir(kind, releaseArchOf(name) ?? "?")).toBe(`macos/${releaseArch(arch)}`);
      }
      expect(() => releaseName(kind, "1.0.3", "x86")).toThrow("not released for x86");
    }
    expect(releaseName("dmg", "1.0.3", "aarch64")).toBe("OpenMind-Studio_1.0.3_macos_arm64.dmg");
    expect(releaseName("macos-app", "1.0.3", "x64")).toBe("OpenMind-Studio_1.0.3_macos_x64.app.zip");
    expect(releaseSubdir("portable", "i686")).toBe("windows/x86");
    expect(releaseSubdir("appimage", "amd64")).toBe("linux/x64");
    expect(releaseArchOf("OpenMind-Studio_1.0.3_linux_x86_portable.tar.gz")).toBe("x86");
    expect(releaseArchOf("notes.md")).toBeNull();
    expect(() => releaseArch("sparc")).toThrow();
  });

  it("the report lists only the files it was given, with type, size and SHA256; an empty list says so", () => {
    const artifacts = [
      {
        name: "OpenMind-Studio_0.1.0_windows_x64_setup.exe",
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
    expect(report).toContain("_0.1.0_windows_x64_setup.exe");
    expect(report).toContain("7.2 MB");
    expect(report).toContain("ab".repeat(32));
    expect(report).toContain("**unsigned**");
    expect(report).not.toContain(".msi");
    // Bare names, sorted, so `sha256sum -c` works on a flat download of the GitHub release.
    expect(
      checksumsText([
        { name: "OpenMind-Studio_0.1.0_windows_x64.msi", kind: "msi", size: 1, sha256: "cd".repeat(32) },
        ...artifacts,
        { name: "OpenMind-Studio_0.1.0_linux_x64.deb", kind: "deb", size: 1, sha256: "ef".repeat(32) },
      ]),
    ).toBe(
      `${"ef".repeat(32)}  OpenMind-Studio_0.1.0_linux_x64.deb\n` +
        `${"cd".repeat(32)}  OpenMind-Studio_0.1.0_windows_x64.msi\n` +
        `${"ab".repeat(32)}  OpenMind-Studio_0.1.0_windows_x64_setup.exe\n`,
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
