// Pure helpers for Windows Authenticode signing (scripts/signtool.mjs, scripts/authenticodeRelease.mjs). No I/O and no
// processes here, so every rule is unit-tested (src/services/authenticode.test.ts). Nothing in this file ever sees a
// certificate password.
//
// Authenticode is a second, separate trust layer: it tells Windows who published a program. OpenMind's own updater/LAN
// signatures (`<file>.sig`, minisign, scripts/sign-release.mjs) stay what the app trusts for updates and deployments;
// they are made AFTER Authenticode, over the final bytes.

/** The Code Signing extended key usage (EKU) a certificate must carry. */
export const CODE_SIGNING_EKU = "1.3.6.1.5.5.7.3.3";
/** RSA public keys (Smart App Control doesn't accept ECC signatures). */
export const RSA_OID = "1.2.840.113549.1.1.1";
/** The text SignTool shows as the signed file's description (`/d`). */
export const SIGNING_DESCRIPTION = "OpenMind Studio";
/** Our own programs inside the portable ZIP: only these are signed. Everything else is a vendor's file (see docs). */
export const OUR_BINARIES = ["OpenMindStudio.exe"];
/** Warn when the certificate expires sooner than this. */
export const EXPIRY_WARNING_DAYS = 30;

/** "10.0.26100.0" -> [10, 0, 26100, 0], for newest-first sorting of Windows SDK folders. */
function versionParts(name) {
  return name.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersionsDesc(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Where signtool.exe is. `SIGNTOOL_PATH` wins (it must name an existing signtool.exe); otherwise the newest Windows 10/11
 * SDK under `%ProgramFiles(x86)%\Windows Kits\10\bin\<version>\<host>\signtool.exe`, preferring the host's own
 * architecture. `fs` = `{ exists(path), list(dir) }`. Returns `{ path }` or `{ problem }`.
 */
export function findSigntoolIn(env, fs, hostArch = "x64") {
  const override = (env.SIGNTOOL_PATH ?? "").trim();
  if (override !== "") {
    if (!/(^|[\\/])signtool\.exe$/i.test(override)) {
      return { problem: `SIGNTOOL_PATH must name signtool.exe (it is "${override}").` };
    }
    return fs.exists(override)
      ? { path: override }
      : { problem: `SIGNTOOL_PATH points to ${override}, which doesn't exist.` };
  }
  const programFiles = env["ProgramFiles(x86)"];
  if (!programFiles) {
    return { problem: "signtool.exe was not found: %ProgramFiles(x86)% is not set (is this Windows?). Set SIGNTOOL_PATH." };
  }
  const bin = `${programFiles}\\Windows Kits\\10\\bin`;
  const hosts = hostArch === "arm64" ? ["arm64", "x64", "x86"] : hostArch === "x86" ? ["x86"] : ["x64", "x86"];
  const versions = fs.exists(bin)
    ? fs
        .list(bin)
        .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
        .sort(compareVersionsDesc)
    : [];
  for (const version of versions) {
    for (const host of hosts) {
      const candidate = `${bin}\\${version}\\${host}\\signtool.exe`;
      if (fs.exists(candidate)) return { path: candidate };
    }
  }
  return {
    problem:
      "signtool.exe was not found. Install the Windows SDK with \"Windows SDK Signing Tools for Desktop Apps\" (Visual Studio Installer or the standalone SDK), or set SIGNTOOL_PATH to signtool.exe.",
  };
}

/**
 * Whether a certificate can sign a release. `info` is what Windows reports (`scripts/signtool.mjs` certificateInfo):
 * `{ found, thumbprint, subject, notBefore, notAfter, hasPrivateKey, ekus, keyAlgorithm, chainTrusted, chainStatus }`.
 * `mode` is readSigningConfig's: a `signed` release needs a trusted chain and an RSA key; `test-signed` accepts a
 * self-signed certificate. Returns `{ problems, warnings }`; any problem means: don't sign.
 */
export function certificateVerdict(info, mode, now = new Date()) {
  const problems = [];
  const warnings = [];
  if (!info || !info.found) {
    return {
      problems: [
        `The certificate was not found${info?.thumbprint ? ` (thumbprint ${info.thumbprint})` : ""} in CurrentUser\\My or LocalMachine\\My. For a hardware token, plug it in and check its middleware put the certificate in the store.`,
      ],
      warnings,
    };
  }
  if (!info.hasPrivateKey) {
    problems.push("The certificate has no usable private key on this computer (token not plugged in, or the wrong certificate).");
  }
  const notBefore = new Date(info.notBefore);
  const notAfter = new Date(info.notAfter);
  if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) {
    problems.push("The certificate's validity dates couldn't be read.");
  } else if (now < notBefore) {
    problems.push(`The certificate is not valid yet (from ${notBefore.toISOString()}).`);
  } else if (now > notAfter) {
    problems.push(`The certificate expired on ${notAfter.toISOString()}. Renew it (docs/code-signing.md, "Renewal").`);
  } else if (notAfter.getTime() - now.getTime() < EXPIRY_WARNING_DAYS * 86_400_000) {
    warnings.push(`The certificate expires on ${notAfter.toISOString()}: renew it soon (timestamped signatures stay valid).`);
  }
  if (!Array.isArray(info.ekus) || !info.ekus.includes(CODE_SIGNING_EKU)) {
    problems.push(`The certificate is not a code-signing certificate (it lacks the Code Signing usage ${CODE_SIGNING_EKU}).`);
  }
  if (info.keyAlgorithm !== RSA_OID) {
    const text = "The certificate's key is not RSA: Windows Smart App Control doesn't accept ECC signatures.";
    if (mode === "signed") problems.push(text);
    else warnings.push(text);
  }
  if (!info.chainTrusted) {
    const status = info.chainStatus?.length ? ` (${info.chainStatus.join(", ")})` : "";
    if (mode === "signed") {
      problems.push(`Windows doesn't trust the certificate's chain${status}. A release needs a certificate from a CA in the Microsoft Trusted Root Program.`);
    } else {
      warnings.push(`TEST certificate: Windows doesn't trust its chain${status}; signatures will show as untrusted on other computers.`);
    }
  }
  if (info.chainTrusted && info.chainStatus?.some((s) => /Revocation/i.test(s))) {
    warnings.push("Revocation could not be checked (offline?): signing continues, but check the certificate is not revoked.");
  }
  return { problems, warnings };
}

/**
 * The `signtool sign` arguments for one file. Always by thumbprint (`/sha1`): a password never goes on a command line.
 * A PFX file is imported into the store first (scripts/signtool.mjs withCertificate). SHA-256 file digest, RFC 3161
 * timestamp with a SHA-256 digest when a timestamp server is configured, and the description.
 */
export function signtoolSignArgs({ thumbprint, store = "user", timestampUrl, description = SIGNING_DESCRIPTION }, file) {
  if (!/^[0-9A-F]{40}$/.test(thumbprint ?? "")) throw new Error("A 40-digit certificate thumbprint is required.");
  const args = ["sign", "/fd", "SHA256", "/sha1", thumbprint, "/s", "My"];
  if (store === "machine") args.push("/sm");
  if (timestampUrl) args.push("/tr", timestampUrl, "/td", "SHA256");
  if (description) args.push("/d", description);
  args.push(file);
  return args;
}

/** A short, actionable reason for a failed `signtool sign`, from its output. */
export function classifySigntoolFailure(output) {
  const text = String(output ?? "");
  if (/timestamp/i.test(text)) {
    return "The timestamp server could not be reached or refused the request. Check TIMESTAMP_URL and the network/proxy, then run again (nothing was released).";
  }
  if (/No certificates were found that met all the given criteria/i.test(text)) {
    return "SignTool found no matching certificate with a private key (thumbprint, store, or the token isn't plugged in).";
  }
  if (/private key|keyset|NTE_|SCARD_/i.test(text)) {
    return "The private key couldn't be used (hardware token locked or missing, or the PIN was refused).";
  }
  if (/being used by another process|access is denied/i.test(text)) {
    return "The file is locked or not writable (a virus scanner or another program has it open). Run again.";
  }
  const first = text.split(/\r?\n/).find((line) => /error/i.test(line)) ?? text.split(/\r?\n/)[0] ?? "";
  return `SignTool failed: ${first.trim() || "no output"}`;
}

/**
 * What to do with one Windows release file, from its current Authenticode state.
 * `state` = `{ exists, signature: { status, signerThumbprint } | null, innerSignature (portable only) }`.
 * Returns `{ action: "keep" | "sign" | "repack" | "refuse", reason }`.
 */
export function planArtifact(kind, state, { thumbprint, signInstallersOuter = false }) {
  if (!state.exists) return { action: "refuse", reason: "the file is missing" };
  const signature = kind === "portable" ? state.innerSignature : state.signature;
  const what = kind === "portable" ? "OpenMindStudio.exe inside the ZIP" : "the file";
  if (signature && signature.status === "HashMismatch") {
    return { action: "refuse", reason: `${what} was changed after it was signed (HashMismatch); rebuild it` };
  }
  if (signature && signature.status !== "NotSigned" && signature.signerThumbprint) {
    if (signature.signerThumbprint.toUpperCase() !== thumbprint) {
      return {
        action: "refuse",
        reason: `${what} is already signed by another certificate (${signature.signerThumbprint}); refusing to mix certificates`,
      };
    }
    return { action: "keep", reason: `${what} is already signed with this certificate` };
  }
  if (kind === "portable") return { action: "repack", reason: "sign OpenMindStudio.exe, rebuild the ZIP" };
  if (!signInstallersOuter) {
    return {
      action: "refuse",
      reason:
        "this installer was built without Authenticode: the program it installs is unsigned. Rebuild with signing configured (scripts\\build-windows.bat), or pass --sign-installers-outer to sign only the installer itself",
    };
  }
  return { action: "sign", reason: "sign the installer itself (the program inside stays unsigned: --sign-installers-outer)" };
}

/**
 * Checks a rebuilt portable ZIP against the original: the same entries, every file byte-identical except the ones that
 * were signed, and those changed. `before`/`after` map entry name -> SHA-256. Returns the problems (empty = fine).
 */
export function compareTrees(before, after, signed) {
  const problems = [];
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const name of [...names].sort()) {
    if (!(name in after)) problems.push(`missing after repacking: ${name}`);
    else if (!(name in before)) problems.push(`unexpected new entry: ${name}`);
    else if (signed.includes(name)) {
      if (before[name] === after[name]) problems.push(`not changed by signing: ${name}`);
    } else if (before[name] !== after[name]) problems.push(`changed although it wasn't signed: ${name}`);
  }
  return problems;
}

/** The human-readable plan for --dry-run and the log: one line per file. */
export function describePlan(steps) {
  const verbs = { keep: "KEEP  ", sign: "SIGN  ", repack: "REPACK", refuse: "REFUSE" };
  return steps.map((s) => `${verbs[s.action] ?? s.action}  ${s.path}: ${s.reason}`);
}
