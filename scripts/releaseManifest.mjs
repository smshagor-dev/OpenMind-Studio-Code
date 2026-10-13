// SHA256SUMS.txt of a release folder (`release/v<version>/`): every release file in `<platform>/<arch>/`
// (windows/x64, windows/x86, linux/x64, linux/x86, macos/arm64, macos/x64), written to `metadata/SHA256SUMS.txt` with
// bare file names, so the same file verifies a flat download of the GitHub release (`sha256sum -c SHA256SUMS.txt`).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  checksumsText,
  METADATA_DIR,
  RELEASE_ARCHES,
  releaseArchOf,
  releaseKindOf,
  releaseSubdir,
} from "./releaseTools.mjs";

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The manifest's path inside a release folder. */
export const manifestPath = (dir) => join(dir, METADATA_DIR, "SHA256SUMS.txt");

/**
 * The release files present in `dir` (`{ name, kind, arch, path, size, sha256 }`, `path` relative to `dir`); other
 * files (`.sig`, notes) are skipped. A release file in the wrong folder (an x86 name in x64/) is reported by
 * {@link misplacedFiles}, not listed here.
 */
export function releaseFiles(dir) {
  const found = [];
  for (const [platform, arches] of Object.entries(RELEASE_ARCHES)) {
    for (const arch of arches) {
      const sub = join(dir, platform, arch);
      if (!existsSync(sub)) continue;
      for (const name of readdirSync(sub).sort()) {
        const kind = releaseKindOf(name);
        const file = join(sub, name);
        if (kind === null || !statSync(file).isFile()) continue;
        if (releaseSubdir(kind, releaseArchOf(name)) !== `${platform}/${arch}`) continue;
        found.push({
          name,
          kind,
          arch,
          path: `${platform}/${arch}/${name}`,
          size: statSync(file).size,
          sha256: sha256(file),
        });
      }
    }
  }
  return found;
}

/** Release files in a folder their name doesn't belong to (e.g. an `_x86` file in `windows/x64/`). */
export function misplacedFiles(dir) {
  const wrong = [];
  for (const [platform, arches] of Object.entries(RELEASE_ARCHES)) {
    for (const arch of arches) {
      const sub = join(dir, platform, arch);
      if (!existsSync(sub)) continue;
      for (const name of readdirSync(sub)) {
        const kind = releaseKindOf(name);
        if (kind !== null && releaseSubdir(kind, releaseArchOf(name)) !== `${platform}/${arch}`) {
          wrong.push(`${platform}/${arch}/${name}`);
        }
      }
    }
  }
  return wrong.sort();
}

/** Writes `dir/metadata/SHA256SUMS.txt` for the files present now; returns them. */
export function writeManifest(dir) {
  const files = releaseFiles(dir);
  mkdirSync(join(dir, METADATA_DIR), { recursive: true });
  writeFileSync(manifestPath(dir), checksumsText(files));
  return files;
}

/** Checks `metadata/SHA256SUMS.txt` against the files; returns problems (empty = every listed file exists and matches). */
export function verifyManifest(dir) {
  const manifest = manifestPath(dir);
  if (!existsSync(manifest)) return [`${manifest} does not exist.`];
  const problems = misplacedFiles(dir).map((path) => `${path}: in the wrong folder for its name`);
  const present = new Map(releaseFiles(dir).map((file) => [file.name, file]));
  const listed = new Set();
  for (const line of readFileSync(manifest, "utf8").split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/.exec(line);
    if (!match || releaseKindOf(match[2]) === null) {
      problems.push(`Not a manifest line: ${line}`);
      continue;
    }
    const [, hash, name] = match;
    if (listed.has(name)) problems.push(`${name}: listed twice`);
    listed.add(name);
    const file = present.get(name);
    if (file === undefined) problems.push(`${name}: missing`);
    else if (file.sha256 !== hash) problems.push(`${name}: SHA-256 differs`);
  }
  for (const file of present.values()) {
    if (!listed.has(file.name)) problems.push(`${file.path}: not in SHA256SUMS.txt`);
  }
  return problems;
}
