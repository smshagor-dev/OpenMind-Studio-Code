// Pure helpers for the release scripts (signing configuration, artifact names and the report text). No I/O here, so they
// are unit-tested (src/services/release.test.ts). A certificate password is never returned, printed or written by
// anything in this file.

/** The environment variables that configure signing. Nothing else is read, and none of them is ever committed. */
export const SIGNING_VARIABLES = [
  "SIGNING_CERT_PATH",
  "SIGNING_CERT_PASSWORD",
  "SIGNING_CERT_THUMBPRINT",
  "TIMESTAMP_URL",
];

/**
 * What signing will do for this environment:
 *  - `unsigned`     nothing is configured: the build is unsigned (development)
 *  - `signed`       a certificate was given: production signing
 *  - `test-signed`  a certificate was given and SIGNING_CERT_KIND=test: a self-signed test certificate
 *  - `misconfigured` a certificate path without its password, or a password without a path: signing is skipped
 * `message` is a sentence for the build log and never contains the password.
 */
export function readSigningConfig(env) {
  const path = (env.SIGNING_CERT_PATH ?? "").trim();
  const password = env.SIGNING_CERT_PASSWORD ?? "";
  const thumbprint = (env.SIGNING_CERT_THUMBPRINT ?? "").replace(/\s/g, "").toUpperCase();
  const timestamp = (env.TIMESTAMP_URL ?? "").trim();
  const test = (env.SIGNING_CERT_KIND ?? "").trim().toLowerCase() === "test";
  if (timestamp !== "" && !/^https?:\/\//i.test(timestamp)) {
    return {
      mode: "misconfigured",
      message:
        "TIMESTAMP_URL must be an http(s) address: signing is skipped and the build is UNSIGNED.",
    };
  }
  // A release signature without an RFC 3161 timestamp stops being valid when the certificate expires: a real
  // certificate needs TIMESTAMP_URL (your certificate authority's time-stamp server), unless explicitly waived.
  const certificateGiven = thumbprint !== "" || (path !== "" && password !== "");
  const timestampWaived = (env.SIGNING_NO_TIMESTAMP ?? "").trim() === "1";
  if (certificateGiven && !test && timestamp === "" && !timestampWaived) {
    return {
      mode: "misconfigured",
      message:
        "A release certificate needs an RFC 3161 time-stamp server (TIMESTAMP_URL), or its signatures expire with the certificate. Set TIMESTAMP_URL (or SIGNING_NO_TIMESTAMP=1 for an internal build): signing is skipped and the build is UNSIGNED.",
    };
  }
  if (thumbprint !== "") {
    // A certificate in the current user's Windows certificate store (the private key never leaves it).
    if (!/^[0-9A-F]{40}$/.test(thumbprint)) {
      return {
        mode: "misconfigured",
        message:
          "SIGNING_CERT_THUMBPRINT must be the certificate's 40-digit SHA-1 thumbprint: signing is skipped and the build is UNSIGNED.",
      };
    }
    return {
      mode: test ? "test-signed" : "signed",
      thumbprint,
      timestampUrl: timestamp === "" ? null : timestamp,
      message: test
        ? "Signing with a TEST certificate from the Windows certificate store: the build is marked TEST-SIGNED (not trusted by other computers)."
        : "Signing with the certificate from the Windows certificate store: the build is marked SIGNED.",
    };
  }
  if (path === "" && password === "") {
    return {
      mode: "unsigned",
      message:
        "No signing certificate configured (SIGNING_CERT_PATH / SIGNING_CERT_PASSWORD): building UNSIGNED. Windows SmartScreen will warn about an unsigned installer.",
    };
  }
  if (path === "" || password === "") {
    return {
      mode: "misconfigured",
      message:
        path === ""
          ? "SIGNING_CERT_PASSWORD is set but SIGNING_CERT_PATH is missing: signing is skipped and the build is UNSIGNED."
          : "SIGNING_CERT_PATH is set but SIGNING_CERT_PASSWORD is missing: signing is skipped and the build is UNSIGNED.",
    };
  }
  return {
    mode: test ? "test-signed" : "signed",
    certPath: path,
    password,
    timestampUrl: timestamp === "" ? null : timestamp,
    message: test
      ? "Signing with a TEST certificate: the build is marked TEST-SIGNED (not trusted by other computers)."
      : "Signing with the configured certificate: the build is marked SIGNED.",
  };
}

/** A copy of the configuration that is safe to log or write to a file (no password, no full path). */
export function publicSigningInfo(config) {
  return { mode: config.mode, message: config.message, timestamp: config.timestampUrl ?? null };
}

/** The `signtool sign` arguments for one file (the password goes in `/p`; callers must not log this list). */
export function signtoolArgs(config, file) {
  if (config.mode !== "signed" && config.mode !== "test-signed") {
    throw new Error("Signing is not configured.");
  }
  const args = config.thumbprint
    ? ["sign", "/fd", "SHA256", "/sha1", config.thumbprint, "/s", "My"]
    : ["sign", "/fd", "SHA256", "/f", config.certPath, "/p", config.password];
  if (config.timestampUrl) args.push("/tr", config.timestampUrl, "/td", "SHA256");
  args.push(file);
  return args;
}

/**
 * Whether one file's Authenticode signature is good enough for `mode`, from what Windows reports
 * (`Get-AuthenticodeSignature`: `status` Valid / NotTrusted / HashMismatch / NotSigned ..., `timestamped`).
 *  - `signed`: the signature must be Valid (chain trusted, file unchanged) and carry an RFC 3161 timestamp, unless the
 *    timestamp was explicitly waived;
 *  - `test-signed`: present and the file unchanged (a test certificate is not trusted by design);
 *  - `external`: as `signed` — the files came back from an outside signing service (SignPath).
 * Returns `null` when it is fine, else the reason.
 */
export function signatureVerdict(info, mode, { timestampWaived = false } = {}) {
  if (info === null || info.status === "NotSigned") return "not signed";
  if (info.status === "HashMismatch") return "the file was changed after it was signed";
  if (mode === "test-signed") return null;
  if (info.status !== "Valid") return `signature status ${info.status}`;
  if (!info.timestamped && !timestampWaived) return "no RFC 3161 timestamp";
  return null;
}

/** Removes a secret from any text (an error message, a command line) before it is printed. */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function checkVersion(version) {
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a version number.`);
}

/** Debian/Linux/Rust spellings of the two architectures -> the release names' `x64` / `x86`. */
const ARCH_ALIASES = { x64: "x64", amd64: "x64", x86_64: "x64", x86: "x86", i386: "x86", i686: "x86" };

/** `windows` or `linux`: the release folder's subfolder an artifact kind goes into. */
export function releasePlatform(kind) {
  switch (kind) {
    case "setup":
    case "msi":
    case "portable":
      return "windows";
    case "deb":
    case "appimage":
    case "linux-portable":
      return "linux";
    default:
      throw new Error(`Unknown artifact kind "${kind}".`);
  }
}

/**
 * The release names (since 1.0.3): `OpenMind-Studio_<version>_<platform>_<arch>` + `_setup.exe` | `.msi` |
 * `_portable.zip` | `.deb` | `.AppImage` | `_portable.tar.gz`, e.g. OpenMind-Studio_1.0.3_windows_x64_setup.exe.
 */
export function releaseName(kind, version, arch = "x64") {
  checkVersion(version);
  const normalized = ARCH_ALIASES[arch];
  if (normalized === undefined) throw new Error(`Unknown architecture "${arch}".`);
  const suffix = {
    setup: "_setup.exe",
    msi: ".msi",
    portable: "_portable.zip",
    deb: ".deb",
    appimage: ".AppImage",
    "linux-portable": "_portable.tar.gz",
  }[kind];
  return `OpenMind-Studio_${version}_${releasePlatform(kind)}_${normalized}${suffix}`;
}

/**
 * A version's release folder, always inside the project: `<project>/release/v<version>` (git-ignored), with the
 * artifacts in `windows/` and `linux/` and SHA256SUMS.txt, latest.json and the report next to them.
 */
export function releaseDir(root, version) {
  checkVersion(version);
  return `${root.replace(/[\\/]+$/, "")}/release/v${version}`;
}

/** Human readable size: 8.8 MB */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The report for the artifacts that EXIST: `artifacts` = [{ name, size, sha256, kind }]. Only what is listed is
 * reported; a missing installer is not invented.
 */
export function reportText({ version, arch, buildType, date, artifacts, notes }) {
  const lines = [
    `# OpenMind Studio ${version} — release artifacts`,
    "",
    `- Version: ${version}`,
    `- Architecture: ${arch}`,
    `- Build type: **${buildType}**`,
    `- Built: ${date}`,
    "",
  ];
  if (artifacts.length === 0) {
    lines.push("No artifact was found. Build the installers first (`pnpm release:build`).", "");
  } else {
    lines.push("| File | Kind | Size | SHA256 |", "| --- | --- | --- | --- |");
    for (const a of artifacts) {
      lines.push(`| ${a.name} | ${a.kind} | ${formatSize(a.size)} | \`${a.sha256}\` |`);
    }
    lines.push("");
  }
  if (buildType === "unsigned") {
    lines.push(
      "These files are **not code-signed**: Windows SmartScreen will show a warning. Production signing needs a real certificate (docs/release.md).",
      "",
    );
  } else if (buildType === "test-signed") {
    lines.push(
      "These files are signed with a **test certificate**: other computers do not trust it.",
      "",
    );
  }
  for (const note of notes ?? []) lines.push(note);
  return `${lines.join("\n")}\n`;
}

/**
 * SHA256SUMS.txt in the `sha256sum` format (hash, two spaces, path), the path relative to the release folder
 * (`windows/<name>`, `linux/<name>`), so `sha256sum -c SHA256SUMS.txt` works from that folder. Sorted by path.
 */
export function checksumsText(artifacts) {
  const lines = artifacts
    .map((a) => `${a.sha256}  ${releasePlatform(a.kind)}/${a.name}`)
    .sort((x, y) => (x.slice(66) < y.slice(66) ? -1 : x.slice(66) > y.slice(66) ? 1 : 0));
  return `${lines.join("\n")}\n`;
}

/** The kind of a file named by {@link releaseName}, or `null` for any other file. */
export function releaseKindOf(name) {
  if (/_windows_(x64|x86)_setup\.exe$/.test(name)) return "setup";
  if (/_windows_(x64|x86)\.msi$/.test(name)) return "msi";
  if (/_windows_(x64|x86)_portable\.zip$/.test(name)) return "portable";
  if (/_linux_(x64|x86)\.deb$/.test(name)) return "deb";
  if (/_linux_(x64|x86)\.AppImage$/.test(name)) return "appimage";
  if (/_linux_(x64|x86)_portable\.tar\.gz$/.test(name)) return "linux-portable";
  return null;
}

/**
 * Environment changes in WiX source that are not the optional PATH entry: only inside a component conditioned on
 * `ADDTOPATH = "1"`, appended (`Part="last"`) and removed on uninstall (`Permanent="no"`). Returns problems.
 */
export function unconditionalEnvironment(wxs) {
  const problems = [];
  const components = wxs.match(/<Component\b[\s\S]*?<\/Component>/g) ?? [];
  for (const component of components) {
    if (!/<Environment\b/.test(component)) continue;
    const optional = /<Condition>\s*ADDTOPATH\s*=\s*"1"\s*<\/Condition>/.test(component);
    const tags = component.match(/<Environment\b[^>]*>/g) ?? [];
    const safe = tags.every((tag) => /Part="last"/.test(tag) && /Permanent="no"/.test(tag));
    if (!optional || !safe) {
      problems.push("The MSI changes an environment variable (PATH) without the ADDTOPATH option.");
    }
  }
  const inComponents = components.join("").match(/<Environment\b/g)?.length ?? 0;
  if ((wxs.match(/<Environment\b/g)?.length ?? 0) > inComponents) {
    problems.push("The MSI changes an environment variable (PATH) outside a component.");
  }
  return problems;
}

/**
 * Checks the MSI's WiX source (`release/wix/x64/main.wxs` and our fragments): environment variables (PATH) change only
 * through the optional ADDTOPATH component, it must show the licence (`WixUILicenseRtf`) and must offer to launch the
 * app at the end. Returns problems.
 */
export function checkWixSource(wxs) {
  const problems = [...unconditionalEnvironment(wxs)];
  if (!/WixUILicenseRtf/.test(wxs)) problems.push("The MSI has no licence page.");
  if (!/WIXUI_EXITDIALOGOPTIONALCHECKBOX/.test(wxs))
    problems.push("The MSI has no launch-after-install option.");
  if (!/ARPPRODUCTICON/.test(wxs) || !/<Icon\b[^>]*SourceFile=/.test(wxs)) {
    problems.push("The MSI has no custom product icon.");
  }
  return problems;
}

/**
 * Checks the installer configuration (`tauri.conf.json`) for the licence agreement: the licence file is packaged,
 * both installers are built, the NSIS installer runs per user (no administrator rights), and the offline language
 * server bundle is copied next to the executable. Returns problems.
 */
export function checkInstallerConfig(tauri, licenseText) {
  const problems = [];
  const bundle = tauri.bundle ?? {};
  if (bundle.licenseFile !== "../LICENSE") problems.push("bundle.licenseFile must be ../LICENSE.");
  if (bundle.license !== "Apache-2.0") problems.push("bundle.license must be Apache-2.0.");
  for (const target of ["nsis", "msi"]) {
    if (!(bundle.targets ?? []).includes(target))
      problems.push(`bundle.targets must include ${target}.`);
  }
  if (bundle.windows?.nsis?.installMode !== "currentUser") {
    problems.push("The NSIS installer must install per user (no administrator rights).");
  }
  if (!bundle.icon?.includes("icons/icon.ico")) {
    problems.push("bundle.icon must include icons/icon.ico for the installed app executable.");
  }
  if (bundle.windows?.nsis?.installerIcon !== "icons/icon.ico") {
    problems.push("The NSIS installer must use icons/icon.ico.");
  }
  if (bundle.windows?.nsis?.uninstallerIcon !== "icons/icon.ico") {
    problems.push("The NSIS uninstaller must use icons/icon.ico.");
  }
  if (!bundle.windows?.wix?.fragmentPaths?.includes("wix/product-icon.wxs")) {
    problems.push("The MSI must include wix/product-icon.wxs for the product icon.");
  }
  if (!/Apache License\s+Version 2\.0, January 2004/.test(licenseText)) {
    problems.push("LICENSE is not the Apache License 2.0 text.");
  }
  if (!licenseText.includes("END OF TERMS AND CONDITIONS")) problems.push("LICENSE is incomplete.");
  const nsis = bundle.windows?.nsis ?? {};
  const wix = bundle.windows?.wix ?? {};
  if (nsis.installerHooks !== "nsis/installer-hooks.nsh") {
    problems.push(
      "The NSIS installer must use nsis/installer-hooks.nsh (the optional PATH / File Explorer check boxes).",
    );
  }
  if (bundle.windows?.allowDowngrades !== false) {
    problems.push(
      "bundle.windows.allowDowngrades must be false (an older setup never replaces a newer installation).",
    );
  }
  if (!wix.fragmentPaths?.includes("wix/integration.wxs")) {
    problems.push(
      "The MSI must include wix/integration.wxs (the optional ADDTOPATH / EXPLORERMENU components).",
    );
  }
  for (const id of ["OmCliPath", "OmExplorerMenu", "OmInstallLayout"]) {
    if (!wix.componentRefs?.includes(id))
      problems.push(`The MSI must reference the ${id} component.`);
  }
  for (const name of ["openmind.cmd", "openmind"]) {
    if (bundle.resources?.[`cli/${name}`] !== `bin/${name}`) {
      problems.push(
        `bundle.resources must copy "cli/${name}" to "bin/${name}" (the command-line launcher).`,
      );
    }
  }
  if (bundle.resources?.["../python-bundle/"] !== "python-bundle/") {
    problems.push(
      'bundle.resources must copy "../python-bundle/" to "python-bundle/" (the offline Python packages).',
    );
  }
  if (bundle.resources?.["../lsp-bundle/"] !== "lsp/") {
    problems.push(
      'bundle.resources must copy "../lsp-bundle/" to "lsp/" (the offline language servers).',
    );
  }
  return problems;
}

/**
 * Checks the NSIS hooks (`src-tauri/nsis/installer-hooks.nsh`): both options start unchecked, silent installs opt in
 * with a switch, the app itself does the work (`--integration`), and the uninstaller removes it except for an update.
 * Returns problems.
 */
export function checkInstallerHooks(nsh) {
  const problems = [];
  if (!/StrCpy \$OmAddPath 0/.test(nsh) || !/StrCpy \$OmAddMenu 0/.test(nsh)) {
    problems.push("The PATH and File Explorer options must start unchecked.");
  }
  for (const flag of ["/ADDTOPATH", "/EXPLORERMENU", "/NETWORK"]) {
    if (!nsh.includes(`"${flag}"`)) problems.push(`Silent installs need the ${flag} switch.`);
  }
  // Look inside the hook macros themselves, not at comments that mention them.
  const macro = (name) =>
    nsh.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`))?.[1] ?? "";
  const install = macro("NSIS_HOOK_POSTINSTALL");
  // The installer, not the app, records how it installed the program (install.json; the app never asks again).
  for (const layout of ["per-user", "network"]) {
    if (!install.includes(`--integration set-layout ${layout}`)) {
      problems.push(`The installer must run --integration set-layout ${layout}.`);
    }
  }
  for (const action of ["add-path", "remove-path", "add-explorer", "remove-explorer"]) {
    if (!install.includes(`--integration ${action}`)) {
      problems.push(`The installer must run --integration ${action}.`);
    }
  }
  const uninstall = macro("NSIS_HOOK_PREUNINSTALL");
  if (!/\$UpdateMode <> 1[\s\S]*--integration remove-all/.test(uninstall)) {
    problems.push("The uninstaller must run --integration remove-all (except for an update).");
  }
  // An existing installation is updated in place, never installed a second time or uninstalled first.
  const preinstall = macro("NSIS_HOOK_PREINSTALL");
  if (!/Call OmDetect/.test(preinstall) || !/StrCpy \$UpdateMode 1/.test(preinstall)) {
    problems.push(
      "NSIS_HOOK_PREINSTALL must find an existing installation and update it in place ($UpdateMode).",
    );
  }
  if (!/"downgrade"/.test(preinstall) || !nsh.includes('"/ALLOWDOWNGRADE"')) {
    problems.push("The setup must refuse to replace a newer installation unless /ALLOWDOWNGRADE is given.");
  }
  if (!/Call OmClaim/.test(preinstall) || !nsh.includes("OM_LOCK_FILE")) {
    problems.push(
      "The setup must check that the installation is not in use and lock it before replacing files.",
    );
  }
  const welcome = nsh.match(/Function OmWelcomeShow\b([\s\S]*?)FunctionEnd/)?.[1] ?? "";
  const updateFirst =
    /\$OmState != "fresh"[\s\S]*Call OmUpdatePage[\s\S]*Return[\s\S]*NSD_CreateFirstRadioButton/;
  if (!updateFirst.test(welcome)) {
    problems.push(
      "The Welcome page of an existing installation must be the Update page (no installation type choice).",
    );
  }
  if (/KillProcess/.test(nsh)) {
    problems.push("The hooks must never close OpenMind Studio for the user (unsaved work, other computers).");
  }
  if (/WriteRegStr|WriteRegExpandStr|EnVar::|setx/i.test(nsh)) {
    problems.push(
      "The hooks must not write the Registry or PATH themselves (the app does it and records it).",
    );
  }
  return problems;
}

/** The GitHub repository the app updates from (tauri.conf.json `plugins.updater.endpoints`). */
export const RELEASE_REPO = "smshagor-dev/OpenMind-Studio";
export const UPDATE_ENDPOINT = `https://github.com/${RELEASE_REPO}/releases/latest/download/latest.json`;

/** Where a file of the GitHub release `v<version>` is downloaded from. */
export function releaseDownloadUrl(version, name) {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${name}`;
}

/** Windows architecture names: release file names use x64/x86, the updater uses Rust's x86_64/i686. */
const UPDATER_ARCH = { x64: "x86_64", x86: "i686" };

/** -1, 0 or 1, comparing plain x.y.z versions. */
export function compareVersions(a, b) {
  const parts = (v) => v.split(/[-+]/)[0].split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The updater feed (`latest.json`, uploaded to the GitHub release; the app reads it through
 * `releases/latest/download/latest.json`, which GitHub resolves to the newest stable release).
 *
 * `files` = `{ kind: "setup" | "msi" | "portable", arch: "x64" | "x86", name, signature }`, `signature` being the
 * minisign `.sig` text made with the release key. For each architecture:
 *  - `windows-<arch>-nsis` = the per-user setup, `windows-<arch>-msi` = the MSI (an installed copy knows which it is);
 *  - `windows-<arch>` = the setup (else the MSI) — read by any copy that isn't a known installer, so it must exist or
 *    those copies get an error instead of "up to date";
 *  - `openmind.portable["windows-<arch>"]` = the signed portable archive (a portable copy swaps its program files);
 *  - `openmind.minimumVersion`: copies older than it must update (mandatory), only when given;
 *  - `openmind.channel` = "stable".
 * A pre-release version, a minimum newer than the release, or a file without a signature is refused: nothing unsigned
 * is ever offered as an update.
 */
export function latestJson({ version, notes, pubDate, minimumVersion = null, files }) {
  checkVersion(version);
  if (/-/.test(version)) throw new Error(`${version} is a pre-release: it never goes into the stable update feed.`);
  if (minimumVersion !== null) {
    checkVersion(minimumVersion);
    if (compareVersions(minimumVersion, version) > 0) {
      throw new Error(`The minimum version ${minimumVersion} is newer than the release ${version}.`);
    }
  }
  const platforms = {};
  const portable = {};
  for (const file of files) {
    const arch = UPDATER_ARCH[file.arch];
    if (!arch) throw new Error(`Unknown architecture "${file.arch}" for ${file.name}.`);
    const signature = (file.signature ?? "").trim();
    if (signature === "") {
      throw new Error(`${file.name} has no update signature (.sig): it can't be offered as an update.`);
    }
    const entry = { signature, url: releaseDownloadUrl(version, file.name) };
    const key = `windows-${arch}`;
    if (file.kind === "setup") {
      platforms[key] = entry;
      platforms[`${key}-nsis`] = entry;
    } else if (file.kind === "msi") {
      platforms[`${key}-msi`] = entry;
      if (!platforms[key]) platforms[key] = entry;
    } else if (file.kind === "portable") {
      portable[key] = entry;
    } else {
      throw new Error(`${file.name}: only setups, MSIs and portable archives go into the update feed.`);
    }
  }
  if (Object.keys(platforms).length === 0) throw new Error("The update feed needs at least one signed installer.");
  const openmind = { channel: "stable", portable };
  if (minimumVersion !== null) openmind.minimumVersion = minimumVersion;
  return { version, notes, pub_date: pubDate, platforms, openmind };
}

/** The version a Tauri update signature was bound to (`--app-version`), or null. `sig` = the base64 `.sig` text. */
export function signedVersion(sig) {
  const text = Buffer.from(sig.trim(), "base64").toString("utf8");
  const comment = text.split("\n").find((line) => line.startsWith("trusted comment:")) ?? "";
  const field = comment.split("\t").find((part) => part.startsWith("version:"));
  return field ? field.slice("version:".length).trim() : null;
}

/** Problems with the updater configuration: a public key, the GitHub endpoint and signed update files. */
export function checkUpdaterConfig(tauri) {
  const problems = [];
  const updater = tauri.plugins?.updater ?? {};
  if (typeof updater.pubkey !== "string" || updater.pubkey.length < 40) {
    problems.push("plugins.updater.pubkey must be the release key's public key.");
  }
  if (JSON.stringify(updater.endpoints ?? []) !== JSON.stringify([UPDATE_ENDPOINT])) {
    problems.push(`plugins.updater.endpoints must be ["${UPDATE_ENDPOINT}"].`);
  }
  if (updater.requireSignedVersion !== true) {
    problems.push(
      "plugins.updater.requireSignedVersion must be true (the feed isn't signed; the version inside each signature is).",
    );
  }
  if (updater.dangerousInsecureTransportProtocol === true) {
    problems.push("The updater must not allow insecure (http) endpoints in a release.");
  }
  if (tauri.bundle?.createUpdaterArtifacts !== true) {
    problems.push("bundle.createUpdaterArtifacts must be true (the updater needs the .sig files).");
  }
  return problems;
}
