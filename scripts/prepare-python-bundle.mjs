// usage: node scripts/prepare-python-bundle.mjs [--check] [--python <python.exe>]
//
// Builds python-bundle/: the Python packages OpenMind Studio installs offline into a portable Python right after the
// Runtime Manager installs it (scripts/python-bundle/config.json lists them; packages.lock pins every package and
// dependency). The only step that downloads: pip builds/fetches the locked wheels, and python.org's Tcl/Tk package (for
// tkinter) is fetched and checked against the Runtime Manager manifest's SHA-256.
//
// The build Python must be CPython 3.14 on 64-bit Windows (the target): `--python`, OPENMIND_BUNDLE_PYTHON or `python`
// on PATH. It runs isolated (-s, PYTHONNOUSERSITE=1, no pip config) and nothing is installed into it.
//
// --check: verifies an existing python-bundle/ (every file present with its SHA-256) and exits 1 when it isn't ready.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADDON_FILE,
  REQUIREMENTS,
  WHEELS_ZIP,
  bundleManifest,
  compareWithLock,
  parseLock,
  parseWheelName,
  requirementsText,
  validatePythonBundle,
} from "./pythonBundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "python-bundle");
const cache = join(root, ".python-bundle-cache");
const config = JSON.parse(readFileSync(join(root, "scripts", "python-bundle", "config.json"), "utf8"));
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function check() {
  const manifestFile = join(out, "bundle.json");
  if (!existsSync(manifestFile)) {
    console.error("python-bundle/ is not built. Run: pnpm python:bundle");
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const problems = validatePythonBundle(manifest, config, (file) => {
    const path = join(out, file);
    return existsSync(path) ? sha256(path) : null;
  });
  if (problems.length > 0) {
    console.error(`python-bundle/ is not ready:\n  ${problems.join("\n  ")}`);
    return 1;
  }
  const size = (statSync(join(out, WHEELS_ZIP)).size / 1048576).toFixed(1);
  console.log(
    `python-bundle/ is complete: ${manifest.wheels.count} wheels (${size} MB) for Python ${manifest.python}` +
      `${manifest.addon ? " + Tcl/Tk" : ""}.`,
  );
  return 0;
}

function buildPython() {
  const exe = option("--python") ?? process.env.OPENMIND_BUNDLE_PYTHON ?? "python";
  const probe = execFileSync(
    exe,
    ["-s", "-c", "import sys, sysconfig; print(f'{sys.version_info[0]}.{sys.version_info[1]} {sysconfig.get_platform()}')"],
    { encoding: "utf8" },
  ).trim();
  const wanted = `${config.python} ${config.platform.replace("_", "-")}`;
  if (probe !== wanted) {
    throw new Error(`The build Python is "${probe}"; it must be "${wanted}" (use --python <python.exe>).`);
  }
  return exe;
}

async function fetchAddon() {
  const manifest = JSON.parse(
    readFileSync(join(root, "crates", "runtime-manager", "manifests", "python.json"), "utf8"),
  );
  const version = manifest.versions.find((v) => v.version === config.runtimeVersion);
  const addon = version?.addons?.find((a) => a.id === config.addon);
  const artifact = addon?.artifacts?.find((a) => a.platform === "windows-x64");
  if (!artifact) throw new Error(`No ${config.addon} add-on for Python ${config.runtimeVersion} in python.json.`);
  const cached = join(cache, ADDON_FILE);
  if (!existsSync(cached) || sha256(cached) !== artifact.sha256) {
    console.log(`Downloading ${artifact.url} ...`);
    const response = await fetch(artifact.url);
    if (!response.ok) throw new Error(`${artifact.url}: HTTP ${response.status}`);
    writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  }
  if (sha256(cached) !== artifact.sha256) throw new Error(`${ADDON_FILE} does not match the manifest's SHA-256.`);
  copyFileSync(cached, join(out, ADDON_FILE));
  return { sha256: artifact.sha256, url: artifact.url };
}

async function build() {
  const python = buildPython();
  const wheelsDir = join(cache, "wheels");
  rmSync(wheelsDir, { recursive: true, force: true });
  mkdirSync(wheelsDir, { recursive: true });
  mkdirSync(out, { recursive: true });
  const lockFile = join(root, "scripts", "python-bundle", "packages.lock");
  console.log(`Building the locked wheels with ${python} ...`);
  execFileSync(
    python,
    ["-s", "-m", "pip", "wheel", "--no-deps", "--prefer-binary", "--no-cache-dir", "--disable-pip-version-check",
      "-r", lockFile, "-w", wheelsDir],
    { stdio: "inherit", env: { ...process.env, PYTHONNOUSERSITE: "1", PIP_CONFIG_FILE: "nul" } },
  );
  const files = readdirSync(wheelsDir).filter((file) => file.endsWith(".whl"));
  const wheels = files.map((file) => {
    const id = parseWheelName(file);
    if (!id) throw new Error(`Unexpected file name: ${file}`);
    return { ...id, file, sha256: sha256(join(wheelsDir, file)) };
  });
  const problems = compareWithLock(parseLock(readFileSync(lockFile, "utf8")), wheels);
  if (problems.length > 0) throw new Error(`The wheels are not the lock:\n  ${problems.join("\n  ")}`);
  const zip = join(out, WHEELS_ZIP);
  rmSync(zip, { force: true });
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Compress-Archive -Path '${wheelsDir}\\*.whl' -DestinationPath '${zip}' -CompressionLevel Optimal`],
    { stdio: "inherit" },
  );
  writeFileSync(join(out, REQUIREMENTS), requirementsText(wheels));
  const addon = config.addon ? await fetchAddon() : null;
  const manifest = bundleManifest({
    config,
    wheels,
    zip: { sha256: sha256(zip), size: statSync(zip).size },
    addon,
    createdAt: new Date().toISOString(),
  });
  writeFileSync(join(out, "bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return check();
}

mkdirSync(cache, { recursive: true });
process.exitCode = args.includes("--check") ? check() : await build();
