// SHA256SUMS.txt of a release folder (`release/v<version>/`): every release file in `windows/` and `linux/`, with its
// path relative to the folder, so a Linux build collected separately and the Windows files end up in one manifest.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { checksumsText, releaseKindOf, releasePlatform } from "./releaseTools.mjs";

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The release files present in `dir` (`{ name, kind, size, sha256 }`); other files (`.sig`, notes) are skipped. */
export function releaseFiles(dir) {
  const found = [];
  for (const platform of ["windows", "linux"]) {
    const sub = join(dir, platform);
    if (!existsSync(sub)) continue;
    for (const name of readdirSync(sub).sort()) {
      const kind = releaseKindOf(name);
      const file = join(sub, name);
      if (kind === null || !statSync(file).isFile()) continue;
      found.push({ name, kind, size: statSync(file).size, sha256: sha256(file) });
    }
  }
  return found;
}

/** Writes `dir/SHA256SUMS.txt` for the files present now; returns them. */
export function writeManifest(dir) {
  const files = releaseFiles(dir);
  writeFileSync(join(dir, "SHA256SUMS.txt"), checksumsText(files));
  return files;
}

/** Checks `dir/SHA256SUMS.txt` against the files; returns problems (empty = every listed file exists and matches). */
export function verifyManifest(dir) {
  const manifest = join(dir, "SHA256SUMS.txt");
  if (!existsSync(manifest)) return [`${manifest} does not exist.`];
  const problems = [];
  const listed = new Set();
  for (const line of readFileSync(manifest, "utf8").split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}((?:windows|linux)\/[^/\\]+)$/.exec(line);
    if (!match) {
      problems.push(`Not a manifest line: ${line}`);
      continue;
    }
    const [, hash, path] = match;
    listed.add(path);
    const file = join(dir, path);
    if (!existsSync(file)) problems.push(`${path}: missing`);
    else if (sha256(file) !== hash) problems.push(`${path}: SHA-256 differs`);
  }
  for (const file of releaseFiles(dir)) {
    const path = `${releasePlatform(file.kind)}/${file.name}`;
    if (!listed.has(path)) problems.push(`${path}: not in SHA256SUMS.txt`);
  }
  return problems;
}
