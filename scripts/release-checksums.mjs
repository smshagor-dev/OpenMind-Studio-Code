// usage: node scripts/release-checksums.mjs [--verify] [--version <x.y.z>] [--dir <release folder>]
// Rewrites (or with --verify only checks) `release/v<version>/metadata/SHA256SUMS.txt` over the release files in
// `<platform>/<arch>/` (default version: tauri.conf.json's). Exit code 1 when a check fails or the folder doesn't exist.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { manifestPath, verifyManifest, writeManifest } from "./releaseManifest.mjs";
import { releaseDir } from "./releaseTools.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const at = args.indexOf("--version");
const version =
  at >= 0
    ? args[at + 1]
    : JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
// --dir: another release folder (scripts/authenticode-release.mjs --release passes it on).
const dirAt = args.indexOf("--dir");
const dir = dirAt >= 0 ? resolve(args[dirAt + 1]) : releaseDir(root, version);
if (!existsSync(dir)) {
  console.error(`${dir} does not exist.`);
  process.exit(1);
}
if (args.includes("--verify")) {
  const problems = verifyManifest(dir);
  for (const problem of problems) console.error(problem);
  console.log(problems.length === 0 ? `${manifestPath(dir)}: every file verified.` : `${problems.length} problem(s).`);
  process.exit(problems.length === 0 ? 0 : 1);
}
const files = writeManifest(dir);
console.log(`Wrote ${manifestPath(dir)} (${files.length} file(s)).`);
