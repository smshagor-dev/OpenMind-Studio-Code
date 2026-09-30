// Pure helpers for the offline Python package bundle (scripts/prepare-python-bundle.mjs), unit-tested in
// src/services/pythonBundle.test.ts. Nothing here touches the disk or the network.

export const BUNDLE_FORMAT = "openmind-python-bundle";
export const BUNDLE_VERSION = 1;
export const WHEELS_ZIP = "packages.zip";
export const REQUIREMENTS = "requirements.txt";
export const ADDON_FILE = "tcltk.msi";

/** PEP 503 name: lower case, runs of `-_.` become `-`. */
export function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** `numpy-2.5.3-cp314-cp314-win_amd64.whl` -> `{ name: "numpy", version: "2.5.3" }`; `null` for anything else. */
export function parseWheelName(file) {
  const match = /^([A-Za-z0-9_.]+)-([A-Za-z0-9_.!+]+)(-\d[^-]*)?-[^-]+-[^-]+-[^-]+\.whl$/.exec(file);
  if (!match) return null;
  return { name: normalizeName(match[1]), version: match[2] };
}

/** `packages.lock` -> `[{ name, version }]` (comments and blank lines skipped). */
export function parseLock(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, version] = line.split("==");
      return { name: normalizeName(name ?? ""), version: (version ?? "").trim() };
    });
}

/** Problems when the built wheels are not exactly the lock (a missing, extra or other-version wheel). */
export function compareWithLock(lock, wheels) {
  const problems = [];
  const built = new Map(wheels.map((wheel) => [wheel.name, wheel.version]));
  for (const { name, version } of lock) {
    if (!built.has(name)) problems.push(`${name}==${version}: no wheel was built`);
    else if (built.get(name) !== version) problems.push(`${name}: built ${built.get(name)}, locked ${version}`);
  }
  const locked = new Set(lock.map((entry) => entry.name));
  for (const wheel of wheels) if (!locked.has(wheel.name)) problems.push(`${wheel.name}: not in the lock`);
  return problems;
}

/** pip's hash-checking requirements: every wheel pinned with its SHA-256, sorted by name. */
export function requirementsText(wheels) {
  const lines = [...wheels]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((wheel) => `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`);
  return `# Installed offline by OpenMind Studio: pip install --no-index --require-hashes -r requirements.txt\n${lines.join("\n")}\n`;
}

export function bundleManifest({ config, wheels, zip, addon, createdAt }) {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt,
    python: config.python,
    runtimeVersion: config.runtimeVersion,
    platform: config.platform,
    stdlib: config.stdlib,
    packages: config.packages,
    wheels: { file: WHEELS_ZIP, sha256: zip.sha256, size: zip.size, count: wheels.length },
    requirements: REQUIREMENTS,
    addon: addon ? { id: config.addon, file: ADDON_FILE, sha256: addon.sha256, url: addon.url } : null,
  };
}

/**
 * Problems with a built bundle: format, version, every file present with its recorded SHA-256, and the packages the
 * configuration asks for. `fileSha` returns a file's SHA-256 (or `null` when it is missing).
 */
export function validatePythonBundle(manifest, config, fileSha) {
  const problems = [];
  if (manifest?.format !== BUNDLE_FORMAT) problems.push("bundle.json is not an OpenMind Python bundle");
  if (manifest?.version !== BUNDLE_VERSION) problems.push(`bundle.json version ${manifest?.version} is not ${BUNDLE_VERSION}`);
  if (manifest?.python !== config.python) problems.push(`the bundle is for Python ${manifest?.python}, not ${config.python}`);
  const zipSha = fileSha(manifest?.wheels?.file ?? WHEELS_ZIP);
  if (zipSha === null) problems.push(`${WHEELS_ZIP} is missing`);
  else if (zipSha !== manifest?.wheels?.sha256) problems.push(`${WHEELS_ZIP} does not match its SHA-256`);
  if (fileSha(REQUIREMENTS) === null) problems.push(`${REQUIREMENTS} is missing`);
  if (config.addon) {
    const addonSha = fileSha(ADDON_FILE);
    if (addonSha === null) problems.push(`${ADDON_FILE} (Tcl/Tk for tkinter) is missing`);
    else if (addonSha !== manifest?.addon?.sha256) problems.push(`${ADDON_FILE} does not match its SHA-256`);
  }
  const listed = new Set((manifest?.packages ?? []).map((p) => p.name));
  for (const pkg of config.packages) if (!listed.has(pkg.name)) problems.push(`${pkg.name} is not in the bundle`);
  return problems;
}
