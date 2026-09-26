// Builds the portable edition: a zip with OpenMindStudio.exe and a README, nothing else.
//
//   pnpm package:portable                 build (release) and package
//   pnpm package:portable -- --no-build   package the exe that is already built
//   pnpm package:portable -- --profile debug --no-build   package a debug build (for testing only)
//
// The app is portable by construction: every path is resolved next to the executable
// (crates/core/src/paths.rs), so the package needs no installer, no Registry and no AppData.
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  builtExe,
  PACKAGE_EXE,
  PACKAGE_FOLDER,
  readmeText,
  validateToolchainManifest,
  zipName,
} from "./portablePackage.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const profile = option("--profile", "release");
const outDir = resolve(root, option("--out", "dist-portable"));
const targetDir = process.env.CARGO_TARGET_DIR ?? join(root, "target");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

if (!flag("--no-build")) {
  // A fixed command line (nothing user-supplied), run through the shell so it finds pnpm.cmd on Windows.
  const command = `pnpm tauri build --no-bundle${profile === "debug" ? " --debug" : ""}`;
  console.log(`Building the ${profile} app (${command})...`);
  execSync(command, { cwd: root, stdio: "inherit" });
}

const tauriExe = builtExe(targetDir, profile);
const exe = option("--exe", existsSync(tauriExe) ? tauriExe : builtExe(targetDir, profile, true));
if (!existsSync(exe)) {
  throw new Error(`The built app was not found at ${exe}. Build it first, or pass --exe <path>.`);
}

const staging = join(outDir, PACKAGE_FOLDER);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
copyFileSync(exe, join(staging, PACKAGE_EXE));
writeFileSync(join(staging, "README.txt"), readmeText(version));

// Optional, developer-populated tool bundle (see docs/toolchains.md). Nothing is downloaded here: the folder must
// already hold the programs, and it is refused unless its manifest checks out.
const bundle = join(root, "tools-bundle");
if (existsSync(join(bundle, "toolchains.json"))) {
  const manifest = JSON.parse(readFileSync(join(bundle, "toolchains.json"), "utf8"));
  const problems = validateToolchainManifest(manifest, (relative) =>
    existsSync(join(root, relative.replace(/^tools[\\/]/, "tools-bundle/"))),
  );
  if (problems.length > 0) {
    throw new Error(
      `tools-bundle/toolchains.json is not ready to package:\n  ${problems.join("\n  ")}`,
    );
  }
  cpSync(bundle, join(staging, "tools"), { recursive: true });
  console.log("Copied tools-bundle/ into the package as tools/.");
} else {
  console.log("No tools-bundle/ found: the package carries no bundled tools.");
}

const zip = join(outDir, zipName(version));
rmSync(zip, { force: true });
execFileSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -LiteralPath '${staging}' -DestinationPath '${zip}' -CompressionLevel Optimal`,
  ],
  { stdio: "inherit" },
);

const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(`${zip}.sha256`, `${sha}  ${zipName(version)}\n`);
console.log(`\nPortable package: ${zip}`);
console.log(`SHA256: ${sha}`);
