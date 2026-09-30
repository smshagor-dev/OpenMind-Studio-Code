// Pure helpers for the release scripts (signing configuration, artifact names and the report text). No I/O here, so they
// are unit-tested (src/services/release.test.ts). A certificate password is never returned, printed or written by
// anything in this file.

/** The environment variables that configure signing. Nothing else is read, and none of them is ever committed. */
export const SIGNING_VARIABLES = ["SIGNING_CERT_PATH", "SIGNING_CERT_PASSWORD", "TIMESTAMP_URL"];

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
  const timestamp = (env.TIMESTAMP_URL ?? "").trim();
  const test = (env.SIGNING_CERT_KIND ?? "").trim().toLowerCase() === "test";
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
  if (timestamp !== "" && !/^https?:\/\//i.test(timestamp)) {
    return {
      mode: "misconfigured",
      message:
        "TIMESTAMP_URL must be an http(s) address: signing is skipped and the build is UNSIGNED.",
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
  const args = ["sign", "/fd", "SHA256", "/f", config.certPath, "/p", config.password];
  if (config.timestampUrl) args.push("/tr", config.timestampUrl, "/td", "SHA256");
  args.push(file);
  return args;
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

/** The release names: OpenMind-Studio-Setup-0.1.0-x64.exe, OpenMind-Studio-0.1.0-x64.msi, OpenMind-Studio-Portable-0.1.0-x64.zip */
export function releaseName(kind, version, arch = "x64") {
  checkVersion(version);
  switch (kind) {
    case "setup":
      return `OpenMind-Studio-Setup-${version}-${arch}.exe`;
    case "msi":
      return `OpenMind-Studio-${version}-${arch}.msi`;
    case "portable":
      return `OpenMind-Studio-Portable-${version}-${arch}.zip`;
    default:
      throw new Error(`Unknown artifact kind "${kind}".`);
  }
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

/** SHA256SUMS.txt in the `sha256sum` format (hash, two spaces, name). */
export function checksumsText(artifacts) {
  return `${artifacts.map((a) => `${a.sha256}  ${a.name}`).join("\n")}\n`;
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
  if (!wix.fragmentPaths?.includes("wix/integration.wxs")) {
    problems.push("The MSI must include wix/integration.wxs (the optional ADDTOPATH / EXPLORERMENU components).");
  }
  for (const id of ["OmCliPath", "OmExplorerMenu"]) {
    if (!wix.componentRefs?.includes(id)) problems.push(`The MSI must reference the ${id} component.`);
  }
  for (const name of ["openmind.cmd", "openmind"]) {
    if (bundle.resources?.[`cli/${name}`] !== `bin/${name}`) {
      problems.push(`bundle.resources must copy "cli/${name}" to "bin/${name}" (the command-line launcher).`);
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
  for (const flag of ["/ADDTOPATH", "/EXPLORERMENU"]) {
    if (!nsh.includes(`"${flag}"`)) problems.push(`Silent installs need the ${flag} switch.`);
  }
  // Look inside the hook macros themselves, not at comments that mention them.
  const macro = (name) => nsh.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`))?.[1] ?? "";
  const install = macro("NSIS_HOOK_POSTINSTALL");
  for (const action of ["add-path", "remove-path", "add-explorer", "remove-explorer"]) {
    if (!install.includes(`--integration ${action}`)) {
      problems.push(`The installer must run --integration ${action}.`);
    }
  }
  const uninstall = macro("NSIS_HOOK_PREUNINSTALL");
  if (!/\$UpdateMode <> 1[\s\S]*--integration remove-all/.test(uninstall)) {
    problems.push("The uninstaller must run --integration remove-all (except for an update).");
  }
  if (/WriteRegStr|WriteRegExpandStr|EnVar::|setx/i.test(nsh)) {
    problems.push("The hooks must not write the Registry or PATH themselves (the app does it and records it).");
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

/**
 * The updater's `latest.json` for a release: the per-user setup is the default Windows update (`windows-x86_64` and
 * `-nsis`), the MSI updates MSI installs (`-msi`). `setup`/`msi` = `{ name, signature }` (the minisign `.sig` text) or null.
 */
export function latestJson({ version, notes, pubDate, setup, msi }) {
  const platforms = {};
  const entry = (file) => ({ signature: file.signature.trim(), url: releaseDownloadUrl(version, file.name) });
  if (setup) {
    platforms["windows-x86_64"] = entry(setup);
    platforms["windows-x86_64-nsis"] = entry(setup);
  }
  if (msi) platforms["windows-x86_64-msi"] = entry(msi);
  return { version, notes, pub_date: pubDate, platforms };
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
  if (updater.dangerousInsecureTransportProtocol === true) {
    problems.push("The updater must not allow insecure (http) endpoints in a release.");
  }
  if (tauri.bundle?.createUpdaterArtifacts !== true) {
    problems.push("bundle.createUpdaterArtifacts must be true (the updater needs the .sig files).");
  }
  return problems;
}
