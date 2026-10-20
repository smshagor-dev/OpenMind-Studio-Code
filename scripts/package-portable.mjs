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
import { peArch } from "./verify-architecture.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const profile = option("--profile", "release");
// Inside the project's git-ignored release folder; `release.mjs --portable <zip>` then copies it into
// `release/v<version>/windows/` under its release name.
const outDir = resolve(root, option("--out", join("release", "staging", "portable")));
// Cargo's real target folder: a machine-local .cargo/config.toml may move it (as build-info.mjs reads it too).
const targetDir =
  process.env.CARGO_TARGET_DIR ??
  JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ).target_directory;
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
// The README names the architecture of the program actually packed (read from its PE header), never a guess.
const arch = peArch(readFileSync(exe));
if (arch === null) throw new Error(`${exe} is not a 64-bit or 32-bit Windows program.`);
writeFileSync(join(staging, "README.txt"), readmeText(version, arch));
// The licence (Apache-2.0) and every third-party notice the program's components require (scripts/third-party-licenses.mjs).
const notices = join(root, "licenses", "THIRD-PARTY-LICENSES.txt");
if (!existsSync(notices)) {
  throw new Error("licenses/THIRD-PARTY-LICENSES.txt is missing: run `pnpm licenses:generate` (pnpm build does it).");
}
copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE.txt"));
copyFileSync(notices, join(staging, "THIRD-PARTY-LICENSES.txt"));
// The License Agreement, Privacy Policy and Terms of Use (scripts/legal-texts.mjs, run by pnpm build).
const legal = join(root, "licenses", "legal");
if (!existsSync(join(legal, "PRIVACY-POLICY.md"))) {
  throw new Error("licenses/legal/ is missing: run `node scripts/legal-texts.mjs` (pnpm build does it).");
}
cpSync(legal, join(staging, "legal"), { recursive: true });
// The launcher (resolves the program next to itself; spaces and non-English folder names are fine).
copyFileSync(
  join(root, "scripts", "launchers", "windows", "Start OpenMind Studio.bat"),
  join(staging, "Start OpenMind Studio.bat"),
);

// The deployment package for a copy placed on a shared folder (shortcut launchers, logon script, push script, README).
cpSync(join(root, "src-tauri", "deploy"), join(staging, "deploy"), { recursive: true });
copyFileSync(
  join(root, "scripts", "deploy", "Deploy-OpenMindShortcuts.ps1"),
  join(staging, "deploy", "Deploy-OpenMindShortcuts.ps1"),
);

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

// The offline language servers (pnpm lsp:bundle). Checked (sizes and SHA256) before they are copied; without them the
// package still works, but language servers must then be installed from npm.
const lspBundle = join(root, "lsp-bundle");
if (existsSync(join(lspBundle, "bundle.json"))) {
  execFileSync(process.execPath, [join(root, "scripts", "prepare-lsp-bundle.mjs"), "--check"], {
    cwd: root,
    stdio: "inherit",
  });
  cpSync(lspBundle, join(staging, "lsp"), { recursive: true });
  console.log("Copied lsp-bundle/ into the package as lsp/.");
} else {
  console.log("No lsp-bundle/ found (run pnpm lsp:bundle): the package carries no offline language servers.");
}

// The offline Python packages (pnpm python:bundle): installed into a portable Python 3.14 right after the Runtime Manager
// installs it. Checked (SHA-256) before they are copied; without them the package still works, packages then come from pip.
const pythonBundle = join(root, "python-bundle");
if (existsSync(join(pythonBundle, "bundle.json"))) {
  execFileSync(process.execPath, [join(root, "scripts", "prepare-python-bundle.mjs"), "--check"], {
    cwd: root,
    stdio: "inherit",
  });
  cpSync(pythonBundle, join(staging, "python-bundle"), { recursive: true });
  console.log("Copied python-bundle/ into the package.");
} else {
  console.log("No python-bundle/ found (run pnpm python:bundle): the package carries no bundled Python packages.");
}

// The official PascalABC.NET console compiler archive, unchanged (pnpm pascalabc:bundle): installed offline by the
// Runtime Manager. Checked against the manifest's SHA-256 before it is copied.
const pascalabcBundle = join(root, "pascalabc-bundle");
if (existsSync(join(pascalabcBundle, "bundle.json"))) {
  execFileSync(process.execPath, [join(root, "scripts", "prepare-pascalabc-bundle.mjs"), "--check"], {
    cwd: root,
    stdio: "inherit",
  });
  cpSync(pascalabcBundle, join(staging, "pascalabc-bundle"), { recursive: true });
  console.log("Copied pascalabc-bundle/ into the package.");
} else {
  console.log("No pascalabc-bundle/ found (run pnpm pascalabc:bundle): PascalABC.NET then downloads from pascalabc.net.");
}

const zip = join(outDir, zipName(version));
rmSync(zip, { force: true });
// Windows' own tar.exe (bsdtar; `-a` picks ZIP from the extension). Not PowerShell's Compress-Archive: it wrote entry
// names with backslashes (not allowed in a ZIP; other unzip tools then show "OpenMind Studio\lsp\..." as one file name),
// and it failed on a fresh copy whenever the virus scanner still held one of the just-copied archives (lsp/packs/*.zip:
// "being used by another process"), so only a second run worked. Not Git's tar on PATH (GNU tar can't write ZIP).
const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
execFileSync(systemTar, ["-a", "-c", "-f", zip, "-C", outDir, PACKAGE_FOLDER], { stdio: "inherit" });

const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(`${zip}.sha256`, `${sha}  ${zipName(version)}\n`);
console.log(`\nPortable package: ${zip}`);
console.log(`SHA256: ${sha}`);
