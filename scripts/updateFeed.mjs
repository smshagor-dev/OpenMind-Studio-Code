// The update feed of a release (`release/v<version>/metadata/latest.json`), written by release.mjs after the
// installers are collected into `release/v<version>/windows/<arch>/`.
//
// - Installers: their `.sig` comes from `tauri build` (createUpdaterArtifacts, the release key in the environment).
// - Portable archives: signed here with the same key and bound to the version (`tauri signer sign --app-version`), so a
//   portable copy can verify and swap its program files like an installed copy verifies its installer.
// - Every signature must name the release's version: the feed itself isn't signed, so the version inside a signature
//   is what proves which release a file belongs to.
// - No feed is written when an installer has no signature: an incomplete feed would leave some copies without updates
//   and others with an error.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { latestJson, METADATA_DIR, releaseSubdir, signedVersion } from "./releaseTools.mjs";
import { updaterSigningEnv } from "./updaterKey.mjs";

function signPortable(file, version) {
  let env;
  try {
    env = updaterSigningEnv();
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
  const result = spawnSync("pnpm", ["tauri", "signer", "sign", "--app-version", version, `"${file}"`], {
    shell: true,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return result.status === 0 ? null : "tauri signer sign failed (the key and password are not shown)";
}

/**
 * `artifacts` = `{ name, kind, arch }` in `out/<platform>/<arch>/` (the release folder). Returns `{ written, notes }`: `notes` are lines for RELEASE-REPORT.md.
 * `minimumVersion` (OPENMIND_MINIMUM_VERSION) makes older copies update (mandatory); `notes` text comes from
 * `notesFile` when given.
 */
export function writeUpdateFeed({ out, version, artifacts, notesFile = null, minimumVersion = null }) {
  const lines = [];
  const files = [];
  for (const artifact of artifacts) {
    if (!["setup", "msi", "portable", "deb", "appimage", "macos-app"].includes(artifact.kind)) continue;
    const file = join(out, releaseSubdir(artifact.kind, artifact.arch), artifact.name);
    const sigFile = `${file}.sig`;
    if (!existsSync(sigFile) && artifact.kind === "portable") {
      const problem = signPortable(file, version);
      if (problem !== null) {
        lines.push(`- ${artifact.name}: no update signature (${problem}); portable copies are told to download it.`);
        continue;
      }
    }
    if (!existsSync(sigFile)) {
      lines.push(`- ${artifact.name}: no update signature (.sig).`);
      files.push({ ...artifact, signature: "" });
      continue;
    }
    const signature = readFileSync(sigFile, "utf8").trim();
    const bound = signedVersion(signature);
    if (bound !== null && bound !== version) {
      lines.push(`- ${artifact.name}: its update signature is for ${bound}, not ${version}.`);
      return { written: false, notes: ["Update feed NOT written:", ...lines] };
    }
    lines.push(`- ${artifact.name}: update signature ${bound === null ? "not bound to a version" : `bound to ${bound}`}`);
    files.push({ ...artifact, signature });
  }
  const notes = notesFile ? readFileSync(notesFile, "utf8").trim() : `OpenMind Studio ${version}`;
  try {
    const feed = latestJson({
      version,
      notes,
      pubDate: new Date().toISOString(),
      minimumVersion,
      files,
    });
    mkdirSync(join(out, METADATA_DIR), { recursive: true });
    writeFileSync(join(out, METADATA_DIR, "latest.json"), `${JSON.stringify(feed, null, 2)}\n`);
    const mandatory = minimumVersion ? `; copies older than ${minimumVersion} must update` : "";
    return {
      written: true,
      notes: [`Update feed: latest.json written (upload it with the files)${mandatory}.`, ...lines],
    };
  } catch (error) {
    return {
      written: false,
      notes: [`Update feed NOT written: ${error instanceof Error ? error.message : error}`, ...lines],
    };
  }
}
