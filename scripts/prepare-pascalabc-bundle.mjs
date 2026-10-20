// usage: node scripts/prepare-pascalabc-bundle.mjs [--check] [--zip <PABCNETC.zip>]
//
// Builds pascalabc-bundle/: the official PascalABC.NET console compiler archive, unchanged, which OpenMind Studio for
// Windows installs offline (the Runtime Manager's PascalABC.NET item; see src-tauri/src/commands/pascalabc.rs). The
// archive must be exactly the one crates/runtime-manager/manifests/pascalabc.json pins (SHA-256 and size): a newer
// build from pascalabc.net is refused until the manifest is updated.
//
//   --zip <file>  use an already downloaded PABCNETC.zip (pascalabc.net refuses connections from some networks)
//   (no --zip)    download it from the manifest's address
//   --check       verify an existing pascalabc-bundle/ and exit 1 when it isn't ready
//
// The licence texts come from licenses/pascalabc/ (the official License_en.txt, copyright.txt and the Programming
// Taskbook licence from github.com/pascalabcnet/pascalabcnet, and the GNU LGPL/GPL v3 texts).

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ARCHIVE, LICENSE_FILES, NOTICE, archiveProblem, bundleRecord, pinnedArtifact, validateBundle } from "./pascalabcBundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "pascalabc-bundle");
const licenses = join(root, "licenses", "pascalabc");
const manifest = JSON.parse(readFileSync(join(root, "crates", "runtime-manager", "manifests", "pascalabc.json"), "utf8"));
const pinned = pinnedArtifact(manifest);
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function describe(file) {
  return { sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), size: statSync(file).size };
}

function check() {
  const recordFile = join(out, "bundle.json");
  if (!existsSync(recordFile)) {
    console.error("pascalabc-bundle/ is not built. Run: pnpm pascalabc:bundle -- --zip <PABCNETC.zip>");
    return 1;
  }
  const problems = validateBundle(JSON.parse(readFileSync(recordFile, "utf8")), pinned, readdirSync(out));
  if (problems.length === 0) {
    const archive = join(out, ARCHIVE);
    const problem = archiveProblem(pinned, describe(archive));
    if (problem) problems.push(`${ARCHIVE}: ${problem}`);
  }
  if (problems.length > 0) {
    console.error(`pascalabc-bundle/ is not ready:\n  ${problems.join("\n  ")}`);
    return 1;
  }
  console.log(`pascalabc-bundle/ is ready: PascalABC.NET ${pinned.version}, ${ARCHIVE} ${pinned.sha256}.`);
  return 0;
}

async function download(target) {
  console.log(`Downloading ${pinned.url} ...`);
  const response = await fetch(pinned.url, { redirect: "error" });
  if (!response.ok) throw new Error(`${pinned.url}: HTTP ${response.status}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}

async function build() {
  mkdirSync(out, { recursive: true });
  const staged = join(out, `${ARCHIVE}.part`);
  const source = option("--zip");
  if (source) copyFileSync(resolve(source), staged);
  else await download(staged);
  const problem = archiveProblem(pinned, describe(staged));
  if (problem) throw new Error(`${source ?? pinned.url} is not the pinned PascalABC.NET archive: ${problem}`);
  renameSync(staged, join(out, ARCHIVE));
  for (const name of LICENSE_FILES.filter((name) => name !== "NOTICE.txt")) {
    copyFileSync(join(licenses, name), join(out, name));
  }
  writeFileSync(join(out, "NOTICE.txt"), NOTICE.replace(/\r?\n/g, "\r\n"));
  writeFileSync(join(out, "bundle.json"), `${JSON.stringify(bundleRecord(pinned), null, 2)}\n`);
  console.log(`Built pascalabc-bundle/ with PascalABC.NET ${pinned.version}.`);
  return check();
}

if (args.includes("--check")) {
  process.exit(check());
} else {
  build().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
