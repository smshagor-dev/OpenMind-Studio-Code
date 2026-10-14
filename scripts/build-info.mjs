// usage: node scripts/build-info.mjs version [--expect <version>]   prints the release version (exit 1 when they differ)
//        node scripts/build-info.mjs target-dir                      prints Cargo's target folder (cargo metadata)
//
// Shared by the build scripts (scripts/build-windows.bat, scripts/linux-release.sh, scripts/build-macos.command), so the
// version and the target folder are read one way on every platform.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { versionSources } from "./buildInfo.mjs";

const root = resolve(import.meta.dirname, "..");
const [command, ...rest] = process.argv.slice(2);

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

if (command === "version") {
  const sources = versionSources({
    packageJson: read("package.json"),
    tauriConf: read(join("src-tauri", "tauri.conf.json")),
    cargoToml: read("Cargo.toml"),
    appCargoToml: read(join("src-tauri", "Cargo.toml")),
  });
  const versions = new Set(sources.map((s) => s.version));
  const expected = rest[0] === "--expect" ? rest[1] : undefined;
  if (versions.size !== 1 || sources.some((s) => s.version === null)) {
    console.error("The version is not the same everywhere:");
    for (const s of sources) console.error(`  ${s.file}: ${s.version ?? "(not found)"}`);
    process.exit(1);
  }
  const [version] = versions;
  if (expected !== undefined && expected !== version) {
    console.error(`The version is ${version}, not ${expected}.`);
    process.exit(1);
  }
  console.log(version);
} else if (command === "target-dir") {
  const metadata = execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  console.log(JSON.parse(metadata).target_directory);
} else {
  console.error("usage: node scripts/build-info.mjs version [--expect <version>] | target-dir");
  process.exit(2);
}
