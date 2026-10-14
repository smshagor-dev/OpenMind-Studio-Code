// usage: node scripts/authenticode-release.mjs [--dry-run | --check] [--arch x64|x86|all] [--version <x.y.z>]
//                                               [--release <folder>] [--sign-installers-outer] [--skip-updater-resign]
//
// Windows Authenticode signing of an already-built release folder (docs/code-signing.md). The certificate comes from
// the environment only (scripts/releaseTools.mjs readSigningConfig):
//   SIGNING_CERT_THUMBPRINT   a certificate in the Windows store (a hardware token / cloud HSM shows up there), or
//   SIGNING_CERT_PATH + the certificate password   a PFX file (imported into the store for the run, never on a command
//                             line; both variable names are in docs/code-signing.md)
//   TIMESTAMP_URL             the RFC 3161 time-stamp server (required for a release certificate)
//   SIGNING_CERT_KIND=test    a self-signed test certificate (signatures are marked test-signed, untrusted elsewhere)
//   SIGNTOOL_PATH             signtool.exe, when it isn't in the Windows SDK's default folder
//
//   --check                   only check SignTool and the certificate; touches no file
//   --dry-run                 print what would be signed and why, change nothing (exit 1 if the real run would stop)
//   --sign-installers-outer   sign a setup/MSI that was built without signing (the program it installs stays unsigned:
//                             the complete way is to rebuild with signing configured, scripts\build-windows.bat)
//   --skip-updater-resign     TEST ONLY (test certificate): remove the stale updater .sig files and latest.json instead
//                             of remaking them; the folder is then not releasable
//
// Afterwards the updater/LAN signatures (.sig), metadata/latest.json and metadata/SHA256SUMS.txt are regenerated for the
// final bytes (scripts/sign-release.mjs: needs the updater key's password) and the folder is verified. Exit code 0 when
// done (or nothing to do), 1 when blocked or failed (nothing left half-changed), 2 for a usage error.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAuthenticodeRelease } from "./authenticodeRelease.mjs";
import { readSigningConfig, releaseDir } from "./releaseTools.mjs";
import { checkCertificate, findSigntoolProblem, inspectSignature, signFile, withCertificate } from "./signtool.mjs";
import { updaterSigningEnv } from "./updaterKey.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const known = ["--dry-run", "--check", "--arch", "--version", "--release", "--sign-installers-outer", "--skip-updater-resign"];
for (let i = 0; i < args.length; i += 1) {
  if (!known.includes(args[i])) {
    console.error(`Unknown argument: ${args[i]}\nusage: see the top of scripts/authenticode-release.mjs`);
    process.exit(2);
  }
  if (["--arch", "--version", "--release"].includes(args[i])) i += 1;
}

const version = option("--version") ?? JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const arch = option("--arch") ?? "all";
if (!["x64", "x86", "all"].includes(arch)) {
  console.error("--arch must be x64, x86 or all");
  process.exit(2);
}
const dir = resolve(option("--release") ?? releaseDir(root, version));
const config = readSigningConfig(process.env);
console.log(config.message);

function certificateScope(fn) {
  if (config.mode === "unsigned") {
    throw new Error(
      "No signing certificate is configured: set SIGNING_CERT_THUMBPRINT (certificate in the Windows store / on a token), or a PFX file (SIGNING_CERT_PATH and its password), and TIMESTAMP_URL (docs/code-signing.md).",
    );
  }
  if (config.mode === "misconfigured") throw new Error(config.message);
  return withCertificate(config, ({ thumbprint }) => {
    const check = checkCertificate(config, thumbprint);
    console.log(`Certificate: ${check.info.subject ?? "(not found)"} (${thumbprint}), valid until ${check.info.notAfter ?? "?"}`);
    return fn({ thumbprint, problems: check.problems, warnings: check.warnings });
  });
}

if (flag("--check")) {
  const tool = findSigntoolProblem();
  let problems = tool ? [tool] : [];
  try {
    certificateScope((cert) => {
      for (const w of cert.warnings) console.log(`warning: ${w}`);
      problems = problems.concat(cert.problems);
    });
  } catch (error) {
    problems.push(String(error instanceof Error ? error.message : error));
  }
  for (const p of problems) console.error(`BLOCKED: ${p}`);
  console.log(problems.length === 0 ? "Authenticode signing is ready." : "Authenticode signing is NOT ready.");
  process.exit(problems.length === 0 ? 0 : 1);
}
if (flag("--skip-updater-resign") && config.mode !== "test-signed") {
  console.error("--skip-updater-resign is only for a test certificate (SIGNING_CERT_KIND=test): a release must keep valid updater signatures.");
  process.exit(2);
}
if (!existsSync(dir)) {
  console.error(`${dir} doesn't exist.`);
  process.exit(1);
}

const abs = (path) => (isAbsolute(path) ? path : join(dir, path));
const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const staging = join(root, "release", "staging");

function sha256(path) {
  const hash = createHash("sha256");
  const fd = openSync(abs(path), "r");
  const buffer = Buffer.alloc(1 << 20);
  try {
    for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0; ) hash.update(buffer.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function hashTree(base) {
  const out = {};
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const full = join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(base, full).split("\\").join("/")] = sha256(full);
    }
  };
  walk(base);
  return out;
}

function node(script, extra = []) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script), ...extra], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(result.stdout ?? "");
  if (result.status === 0) return null;
  return (result.stderr || result.stdout || `${script} failed`).trim().split(/\r?\n/).slice(-3).join(" ");
}

const effects = {
  log: (line) => console.log(line),
  signtoolProblem: () => findSigntoolProblem(),
  withSigningCertificate: certificateScope,
  exists: (path) => existsSync(abs(path)),
  signature: (path) => inspectSignature(abs(path)),
  sign: (path) => signFile(config, abs(path)),
  extract: (zip, target) => {
    mkdirSync(target, { recursive: true });
    execFileSync(tar, ["-x", "-f", abs(zip), "-C", target], { stdio: "inherit" });
  },
  createZip: (base, folder, zip) => {
    rmSync(abs(zip), { force: true });
    execFileSync(tar, ["-a", "-c", "-f", abs(zip), "-C", base, folder], { stdio: "inherit" });
  },
  hashTree,
  sha256,
  tempDir: (prefix) => {
    mkdirSync(staging, { recursive: true });
    return mkdtempSync(join(staging, `authenticode-${prefix}-`));
  },
  copyFile: (from, to) => {
    mkdirSync(dirname(abs(to)), { recursive: true });
    copyFileSync(abs(from), abs(to));
  },
  rename: (from, to) => renameSync(abs(from), abs(to)),
  remove: (path) => rmSync(abs(path), { force: true }),
  removeTree: (path) => rmSync(path, { recursive: true, force: true }),
  stamp: () => new Date().toISOString().replace(/[:.]/g, "-"),
  updaterProblem: () => {
    try {
      updaterSigningEnv();
      return null;
    } catch (error) {
      return String(error instanceof Error ? error.message : error);
    }
  },
  // Every helper is given this very folder (never left to pick the default one by version).
  resignUpdater: () => node("sign-release.mjs", ["--version", version, "--dir", dir]),
  writeChecksums: () => node("release-checksums.mjs", ["--dir", dir]),
  verifyRelease: ({ skipUpdater }) =>
    node("release-checksums.mjs", ["--verify", "--dir", dir]) ??
    (skipUpdater ? null : node("verify-updater-signatures.mjs", [dir, "--require-all"])),
};

console.log(`Release folder: ${dir}${flag("--dry-run") ? " (dry run)" : ""}`);
const result = runAuthenticodeRelease(
  {
    version,
    arches: arch === "all" ? ["x64", "x86"] : [arch],
    dryRun: flag("--dry-run"),
    signInstallersOuter: flag("--sign-installers-outer"),
    skipUpdater: flag("--skip-updater-resign"),
  },
  effects,
);
for (const change of result.changed) console.log(`  ${change.path}\n    before ${change.before}\n    after  ${change.after}`);
process.exit(result.ok ? 0 : 1);
