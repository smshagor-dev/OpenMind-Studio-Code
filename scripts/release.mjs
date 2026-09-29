// usage: node scripts/release.mjs [--target-dir <cargo target dir>] [--targets <triple,...>] [--portable <zip>] [--no-sign]
//
// `--targets` collects cross-target builds (`tauri build --target <triple>`), e.g.
// `x86_64-pc-windows-msvc,i686-pc-windows-msvc`; without it the host build in `<target dir>/release` is collected as x64.
//
// After `pnpm release:build` (tauri build --bundles nsis,msi): copies the installers that exist into `release/` under
// their release names, signs them when a certificate is configured through the environment (SIGNING_CERT_PATH,
// SIGNING_CERT_PASSWORD, optional TIMESTAMP_URL and SIGNING_CERT_KIND=test), and writes SHA256SUMS.txt and
// RELEASE-REPORT.md for the files that exist. Nothing is uploaded and no secret is printed or written.
import { spawnSync } from "node:child_process";
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
  checkWixSource,
  checksumsText,
  publicSigningInfo,
  readSigningConfig,
  redact,
  releaseName,
  reportText,
  signtoolArgs,
} from "./releaseTools.mjs";

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

function findSigntool() {
  const kits = process.env["ProgramFiles(x86)"]
    ? join(process.env["ProgramFiles(x86)"], "Windows Kits", "10", "bin")
    : null;
  if (!kits || !existsSync(kits)) return null;
  const versions = readdirSync(kits)
    .filter((v) => /^\d/.test(v))
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = join(kits, version, "x64", "signtool.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const tauri = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = tauri.version;
const problems = checkInstallerConfig(tauri, readFileSync(join(root, "LICENSE"), "utf8"));
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
    const wixProblems = checkWixSource(`${generatedWix}\n${productIconFragment}`);
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
const present = found.filter((entry) => entry.from !== null && existsSync(entry.from));
const out = join(root, "release");
mkdirSync(out, { recursive: true });
const config = readSigningConfig(process.env);
console.log(config.message);
const secrets = [process.env.SIGNING_CERT_PASSWORD];
let signedCount = 0;
const artifacts = [];

for (const entry of present) {
  const name = releaseName(entry.kind, version, entry.arch);
  const target = join(out, name);
  copyFileSync(entry.from, target);
  const canSign =
    (config.mode === "signed" || config.mode === "test-signed") &&
    !args.includes("--no-sign") &&
    entry.kind !== "portable";
  if (canSign) {
    const tool = findSigntool();
    if (tool === null) {
      console.error("signtool.exe (Windows SDK) was not found: this file stays unsigned.");
    } else {
      const result = spawnSync(tool, signtoolArgs(config, target), { encoding: "utf8" });
      if (result.status === 0) {
        signedCount += 1;
        console.log(`Signed ${name}.`);
      } else {
        console.error(
          `Signing ${name} failed: ${redact(result.stderr || result.stdout || "signtool error", secrets)}`,
        );
      }
    }
  }
  artifacts.push({ name, kind: entry.kind, size: statSync(target).size, sha256: sha256(target) });
}

// A build is only "signed" when every signable file was signed.
const signable = artifacts.filter((a) => a.kind !== "portable").length;
const buildType = signedCount > 0 && signedCount === signable ? config.mode : "unsigned";

writeFileSync(join(out, "SHA256SUMS.txt"), checksumsText(artifacts));
writeFileSync(
  join(out, "RELEASE-REPORT.md"),
  reportText({
    version,
    arch: [...new Set(present.map((entry) => entry.arch))].join(", ") || "x64",
    buildType,
    date: new Date().toISOString(),
    artifacts,
    notes: [`Signing: ${JSON.stringify(publicSigningInfo(config))}`],
  }),
);
console.log(`Wrote ${artifacts.length} artifact(s) to ${out} (${buildType}).`);
for (const a of artifacts) console.log(`  ${a.name}  ${a.size} bytes  ${a.sha256}`);
