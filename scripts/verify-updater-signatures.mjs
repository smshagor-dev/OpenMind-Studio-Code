// usage: node scripts/verify-updater-signatures.mjs [--require-all] [<release folder>]
// Checks the updater signatures of a release folder (default: release/v<version> of this project) independently of Tauri:
//   - every release file's `<file>.sig` (minisign, Ed25519 over the file's BLAKE2b-512, plus the global signature over
//     the trusted comment) against `plugins.updater.pubkey` in tauri.conf.json, made with that key (key id) and bound to
//     the version (`version:<v>` in the trusted comment, which the app requires: requireSignedVersion);
//   - metadata/latest.json, when present: its version, and that every entry's URL names a file of this folder whose
//     `.sig` is exactly the entry's signature.
// --require-all: a release file without a `.sig` is a failure (otherwise it is only listed). Exit code 1 on any failure.
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseFiles } from "./releaseManifest.mjs";
import { METADATA_DIR, releaseDir, releaseKindOf } from "./releaseTools.mjs";

/** `{ keyId, key }` of a base64 minisign public key (plugins.updater.pubkey). */
export function publicKey(base64) {
  const lines = Buffer.from(base64, "base64").toString("utf8").trim().split(/\r?\n/);
  const raw = Buffer.from(lines[1], "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("not a minisign public key");
  const jwk = { kty: "OKP", crv: "Ed25519", x: raw.subarray(10, 42).toString("base64url") };
  return { keyId: raw.subarray(2, 10), key: createPublicKey({ key: jwk, format: "jwk" }) };
}

/** Verifies `data` against a Tauri `.sig` text (base64 of the minisign signature file). Returns the bound version. */
export function verifySignature(data, sigText, { keyId, key }) {
  const lines = Buffer.from(sigText.trim(), "base64").toString("utf8").split(/\r?\n/);
  const sig = Buffer.from(lines[1] ?? "", "base64");
  const trusted = (lines[2] ?? "").replace(/^trusted comment: /, "");
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (sig.length !== 74) throw new Error("not a minisign signature");
  if (!sig.subarray(2, 10).equals(keyId)) throw new Error("made with another key");
  const prehashed = sig.subarray(0, 2).toString("latin1") === "ED";
  const message = prehashed ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, key, sig.subarray(10, 74))) throw new Error("the file doesn't match its signature");
  const signedComment = Buffer.concat([sig.subarray(10, 74), Buffer.from(trusted, "utf8")]);
  if (!verify(null, signedComment, key, global)) throw new Error("the trusted comment was changed");
  return /(?:^|\s)version:(\S+)/.exec(trusted)?.[1] ?? null;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const version = conf.version;
  const pub = publicKey(conf.plugins.updater.pubkey);
  const dir = resolve(args.find((a) => !a.startsWith("--")) ?? releaseDir(root, version));
  let failures = 0;
  const fail = (line) => {
    failures += 1;
    console.log(`FAIL ${line}`);
  };
  const files = releaseFiles(dir);
  const pathOf = new Map(files.map((f) => [f.name, f.path]));
  for (const { path } of files) {
    const file = join(dir, path);
    if (!existsSync(`${file}.sig`)) {
      if (args.includes("--require-all")) fail(`${path}: no .sig`);
      else console.log(`-    ${path}: no .sig`);
      continue;
    }
    try {
      const bound = verifySignature(readFileSync(file), readFileSync(`${file}.sig`, "utf8"), pub);
      if (bound !== version) fail(`${path}: signed for version ${bound ?? "(none)"}, not ${version}`);
      else console.log(`OK   ${path}: signed for ${bound}`);
    } catch (error) {
      fail(`${path}: ${error.message}`);
    }
  }
  const feedFile = join(dir, METADATA_DIR, "latest.json");
  if (existsSync(feedFile)) {
    const feed = JSON.parse(readFileSync(feedFile, "utf8"));
    if (feed.version !== version) fail(`latest.json: version ${feed.version}, not ${version}`);
    const entries = [
      ...Object.entries(feed.platforms ?? {}),
      ...Object.entries(feed.openmind?.portable ?? {}).map(([key, value]) => [`portable ${key}`, value]),
    ];
    for (const [key, entry] of entries) {
      const name = decodeURIComponent(String(entry.url).split("/").pop() ?? "");
      const file = releaseKindOf(name) !== null && pathOf.has(name) ? join(dir, pathOf.get(name)) : null;
      if (!String(entry.url).startsWith(`https://github.com/`) || !String(entry.url).includes(`/v${version}/`)) {
        fail(`latest.json ${key}: ${entry.url} is not this release's https address`);
      } else if (file === null || !existsSync(file) || !existsSync(`${file}.sig`)) {
        fail(`latest.json ${key}: ${name} is not in this release folder (with its .sig)`);
      } else if (readFileSync(`${file}.sig`, "utf8").trim() !== String(entry.signature).trim()) {
        fail(`latest.json ${key}: the signature differs from ${name}.sig`);
      } else {
        console.log(`OK   latest.json ${key} -> ${name}`);
      }
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}
