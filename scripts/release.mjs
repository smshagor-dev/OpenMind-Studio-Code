// usage: node scripts/release.mjs [--target-dir <cargo target dir>] [--targets <triple,...>] [--portable <zip>] [--portable-x86 <zip>] [--no-sign] [--notes <file>]
//
// Also writes release/latest.json, the update feed installed copies read (scripts/updateFeed.mjs): upload it with the
// files and their .sig. OPENMIND_MINIMUM_VERSION=<x.y.z> makes older copies update (mandatory).
//
// `--targets` collects cross-target builds (`tauri build --target <triple>`), e.g.
// `x86_64-pc-windows-msvc,i686-pc-windows-msvc`; without it the host build in `<target dir>/release` is collected as x64.
//
// After `pnpm release:build` (tauri build --bundles nsis,msi): copies the installers that exist into `release/` under
// their release names (with their updater `.sig` files), signs those `tauri build` didn't already sign when a
// certificate is configured through the environment (SIGNING_CERT_THUMBPRINT, or SIGNING_CERT_PATH +
// SIGNING_CERT_PASSWORD; optional TIMESTAMP_URL and SIGNING_CERT_KIND=test), and writes SHA256SUMS.txt and
// RELEASE-REPORT.md for the files that exist. Nothing is uploaded and no secret is printed or written.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkInstallerConfig,
  checkInstallerHooks,
  checkWixSource,
  checksumsText,
  publicSigningInfo,
  readSigningConfig,
  releaseName,
  reportText,
  signatureVerdict,
} from "./releaseTools.mjs";
import { hasSignature, inspectSignature, signFile } from "./signtool.mjs";
import { writeUpdateFeed } from "./updateFeed.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function targetDir() {
  const given = option("--target-dir");
  if (given) return resolve(given);
  const config = join(root, ".cargo", "config.toml");
  if (existsSync(config)) {
    const match = /target-dir\s*=\s*"([^"]+)"/.exec(readFileSync(config, "utf8"));
    if (match) return resolve(match[1]);
  }
  return join(root, "target");
}

function newest(dir, extension) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(extension))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const tauri = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = tauri.version;
const problems = [
  ...checkInstallerConfig(tauri, readFileSync(join(root, "LICENSE"), "utf8")),
  ...checkInstallerHooks(
    readFileSync(join(root, "src-tauri", "nsis", "installer-hooks.nsh"), "utf8"),
  ),
];
if (problems.length > 0) {
  console.error(`Installer configuration problems:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

/** Rust target triple -> release architecture name; `null` = the host build (x64). */
const ARCH_OF = { "x86_64-pc-windows-msvc": "x64", "i686-pc-windows-msvc": "x86" };
const triples = option("--targets")?.split(",").filter(Boolean) ?? [null];
const found = [];
for (const triple of triples) {
  if (triple !== null && !(triple in ARCH_OF)) {
    console.error(`Unknown target "${triple}". Known: ${Object.keys(ARCH_OF).join(", ")}.`);
    process.exit(1);
  }
  const arch = triple === null ? "x64" : ARCH_OF[triple];
  const releaseDir =
    triple === null ? join(targetDir(), "release") : join(targetDir(), triple, "release");
  const wixDir = join(releaseDir, "wix", arch);
  const wixSource = join(wixDir, "main.wxs");
  if (existsSync(wixSource)) {
    const generatedWix = existsSync(wixDir)
      ? readdirSync(wixDir)
          .filter((file) => file.toLowerCase().endsWith(".wxs"))
          .map((file) => readFileSync(join(wixDir, file), "utf8"))
          .join("\n")
      : readFileSync(wixSource, "utf8");
    const productIconFragment = readFileSync(
      join(root, "src-tauri", "wix", "product-icon.wxs"),
      "utf8",
    );
    const integrationFragment = readFileSync(
      join(root, "src-tauri", "wix", "integration.wxs"),
      "utf8",
    );
    const wixProblems = checkWixSource(
      `${generatedWix}\n${productIconFragment}\n${integrationFragment}`,
    );
    if (wixProblems.length > 0) {
      console.error(`MSI configuration problems (${arch}):\n- ${wixProblems.join("\n- ")}`);
      process.exit(1);
    }
  }
  const bundleDir = join(releaseDir, "bundle");
  found.push(
    { kind: "setup", arch, from: newest(join(bundleDir, "nsis"), ".exe") },
    { kind: "msi", arch, from: newest(join(bundleDir, "msi"), ".msi") },
  );
}
if (option("--portable")) found.push({ kind: "portable", arch: "x64", from: option("--portable") });
if (option("--portable-x86"))
  found.push({ kind: "portable", arch: "x86", from: option("--portable-x86") });
const present = found.filter((entry) => entry.from !== null && existsSync(entry.from));
const out = join(root, "release");
mkdirSync(out, { recursive: true });
const config = readSigningConfig(process.env);
console.log(config.message);
let signedCount = 0;
const artifacts = [];

for (const entry of present) {
  const name = releaseName(entry.kind, version, entry.arch);
  const target = join(out, name);
  copyFileSync(entry.from, target);
  // The updater signature (`.sig`, made by `tauri build`) belongs to these exact bytes.
  if (existsSync(`${entry.from}.sig`)) copyFileSync(`${entry.from}.sig`, `${target}.sig`);
  const wantsSigning =
    (config.mode === "signed" || config.mode === "test-signed") &&
    !args.includes("--no-sign") &&
    entry.kind !== "portable";
  if (wantsSigning) {
    if (hasSignature(target)) {
      // Signed during `tauri build` (signCommand); signing again would invalidate the `.sig` file.
      signedCount += 1;
      console.log(`${name} is already signed.`);
    } else {
      const problem = signFile(config, target);
      if (problem === null) {
        signedCount += 1;
        console.log(`Signed ${name}.`);
        if (existsSync(`${target}.sig`)) {
          console.error(
            `${name}.sig no longer matches the signed file: re-sign it with the updater key.`,
          );
        }
      } else {
        console.error(`Signing ${name} failed: ${problem}`);
      }
    }
  }
  artifacts.push({
    name,
    kind: entry.kind,
    arch: entry.arch,
    size: statSync(target).size,
    sha256: sha256(target),
  });
}

// A build is only "signed" when every signable file was signed — and Windows itself confirms each signature (trusted
// chain, unchanged file, RFC 3161 timestamp for a release certificate).
const signable = artifacts.filter((a) => a.kind !== "portable").length;
const signatureNotes = [];
let verifyFailures = 0;
// Signed by an outside service before this script ran (the release workflow's SignPath steps): only verified here.
const external = process.env.SIGNING_EXTERNAL === "true";
const verifyMode = external ? "external" : config.mode;
if (external) signedCount = signable;
if (verifyMode === "signed" || verifyMode === "test-signed" || verifyMode === "external") {
  for (const a of artifacts.filter((entry) => entry.kind !== "portable")) {
    const info = inspectSignature(join(out, a.name));
    const problem = signatureVerdict(info, verifyMode, {
      timestampWaived: process.env.SIGNING_NO_TIMESTAMP === "1",
    });
    signatureNotes.push(
      `- ${a.name}: ${problem === null ? "verified" : `NOT verified (${problem})`} — status ${info.status}, ${info.timestamped ? "timestamped" : "no timestamp"}`,
    );
    if (problem !== null) {
      verifyFailures += 1;
      console.error(`${a.name}: signature not verified: ${problem}`);
    }
  }
}
const buildType =
  signedCount > 0 && signedCount === signable && verifyFailures === 0
    ? external
      ? "signed"
      : config.mode
    : "unsigned";

// The update feed (latest.json) for the files just collected; signed builds only (the signatures are what installed
// copies check, and signing an installer after its .sig was made would break it).
const feed = writeUpdateFeed({
  out,
  version,
  artifacts,
  notesFile: option("--notes") ?? null,
  minimumVersion: process.env.OPENMIND_MINIMUM_VERSION?.trim() || null,
});
for (const line of feed.notes) console.log(line);

writeFileSync(join(out, "SHA256SUMS.txt"), checksumsText(artifacts));
writeFileSync(
  join(out, "RELEASE-REPORT.md"),
  reportText({
    version,
    arch: [...new Set(present.map((entry) => entry.arch))].join(", ") || "x64",
    buildType,
    date: new Date().toISOString(),
    artifacts,
    notes: [`Signing: ${JSON.stringify(publicSigningInfo(config))}`, ...signatureNotes, "", ...feed.notes],
  }),
);
console.log(`Wrote ${artifacts.length} artifact(s) to ${out} (${buildType}).`);
for (const a of artifacts) console.log(`  ${a.name}  ${a.size} bytes  ${a.sha256}`);
if (verifyFailures > 0) {
  console.error(`${verifyFailures} signature(s) could not be verified: the build is reported UNSIGNED.`);
  process.exit(1);
}
