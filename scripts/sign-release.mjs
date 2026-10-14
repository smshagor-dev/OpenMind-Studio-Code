// usage: node scripts/sign-release.mjs [--version <x.y.z>] [--force] [--dir <release folder>]
// Makes the updater signature (`<file>.sig`, minisign, bound to the version: `tauri signer sign --app-version`) of every
// release file in release/v<version>/<platform>/<arch>/ that has none (or every one with --force), with the release key
// (scripts/updaterKey.mjs: ~/.tauri/openmind-studio.key + its password). Each new signature is checked independently
// against plugins.updater.pubkey before it is kept. Then metadata/latest.json and metadata/SHA256SUMS.txt are rewritten.
//
// Run it on the FINAL bytes: after any Authenticode signing (which changes an installer), never before. The key and its
// password only reach the `tauri signer` process; nothing is printed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseFiles, writeManifest } from "./releaseManifest.mjs";
import { releaseDir } from "./releaseTools.mjs";
import { writeUpdateFeed } from "./updateFeed.mjs";
import { updaterSigningEnv } from "./updaterKey.mjs";
import { publicKey, verifySignature } from "./verify-updater-signatures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const at = args.indexOf("--version");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = at >= 0 ? args[at + 1] : conf.version;
// --dir: another release folder (scripts/authenticode-release.mjs --release passes it on).
const dirAt = args.indexOf("--dir");
const out = dirAt >= 0 ? resolve(args[dirAt + 1]) : releaseDir(root, version);
const pub = publicKey(conf.plugins.updater.pubkey);

let env;
try {
  env = updaterSigningEnv();
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}

const signedFor = (file) => {
  try {
    return verifySignature(readFileSync(file), readFileSync(`${file}.sig`, "utf8"), pub);
  } catch {
    return null;
  }
};

let failures = 0;
const files = releaseFiles(out);
for (const { path } of files) {
  const file = join(out, path);
  if (!args.includes("--force") && existsSync(`${file}.sig`) && signedFor(file) === version) {
    console.log(`kept   ${path}`);
    continue;
  }
  rmSync(`${file}.sig`, { force: true });
  const result = spawnSync("pnpm", ["tauri", "signer", "sign", "--app-version", version, `"${file}"`], {
    shell: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  const bound = result.status === 0 && existsSync(`${file}.sig`) ? signedFor(file) : null;
  if (bound === version) {
    console.log(`signed ${path} (bound to ${bound})`);
  } else {
    failures += 1;
    rmSync(`${file}.sig`, { force: true });
    console.error(`FAILED ${path}: no valid signature bound to ${version} (the key and password are not shown)`);
  }
}
if (failures > 0) {
  console.error(`${failures} file(s) could not be signed: the update feed was not written.`);
  process.exit(1);
}
const feed = writeUpdateFeed({
  out,
  version,
  artifacts: files,
  notesFile: null,
  minimumVersion: process.env.OPENMIND_MINIMUM_VERSION?.trim() || null,
});
for (const line of feed.notes) console.log(line);
const listed = writeManifest(out);
console.log(`metadata/SHA256SUMS.txt lists ${listed.length} file(s).`);
process.exit(feed.written ? 0 : 1);
