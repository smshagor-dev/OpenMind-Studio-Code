// Pure helpers for `prepare-lsp-bundle.mjs` and the packaging checks: names, the manifest the app reads
// (`lsp/bundle.json`, see crates/lsp/src/bundle.rs) and its validation. Kept free of I/O so they are
// unit-tested (src/services/lspBundle.test.ts).

export const BUNDLE_FORMAT = "openmind-lsp-bundle";
export const BUNDLE_VERSION = 1;
export const BUNDLE_PLATFORM = "windows-x64";

const SHA256 = /^[0-9a-f]{64}$/;

/** `packs/python-1.zip` */
export function packFileName(id, revision) {
  if (!/^[a-z0-9-]+$/.test(id) || !/^[0-9A-Za-z.-]+$/.test(revision)) {
    throw new Error(`"${id}" / "${revision}" can't name a pack.`);
  }
  return `packs/${id}-${revision}.zip`;
}

/** A bundle path must stay inside `lsp/`: relative, forward slashes, no `..`, drive or root. */
export function safeRelative(path) {
  if (typeof path !== "string" || path === "" || /[\\:\0]/.test(path) || path.startsWith("/")) {
    return false;
  }
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Where an archive entry goes after dropping `strip` leading folders, or `null` when it is dropped
 * (a folder, fully stripped, or listed in `skip` after stripping).
 */
export function strippedName(name, strip, skip = []) {
  const parts = name
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "");
  if (parts.length <= strip) return null;
  const kept = parts.slice(strip).join("/");
  if (name.endsWith("/") || skip.includes(kept)) return null;
  return kept;
}

/** The `lsp/bundle.json` object. */
export function bundleManifest({ createdAt, node, packs }) {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    platform: BUNDLE_PLATFORM,
    createdAt,
    node,
    packs: [...packs].sort((a, b) => a.package.localeCompare(b.package)),
  };
}

/**
 * Checks a prepared bundle. `expected` is the registry's package list (`bundle_tool packages`: every package with
 * `redistributable`; only those may — and must — have a pack); `fileSize(relative)`
 * returns the size of a file inside the bundle folder or `null` when it is missing. Returns problems (empty = fine).
 */
export function validateLspBundle(manifest, expected, fileSize) {
  const problems = [];
  if (manifest?.format !== BUNDLE_FORMAT)
    problems.push("bundle.json is not an OpenMind LSP bundle.");
  if (manifest?.version !== BUNDLE_VERSION)
    problems.push(`bundle.json must be version ${BUNDLE_VERSION}.`);
  if (manifest?.platform !== BUNDLE_PLATFORM)
    problems.push(`bundle.json must be for ${BUNDLE_PLATFORM}.`);
  const node = manifest?.node;
  if (!node || !safeRelative(node.path) || !SHA256.test(node.sha256 ?? "")) {
    problems.push("bundle.json has no valid Node.js entry.");
  } else if (fileSize(node.path) !== node.size) {
    problems.push(`${node.path} is missing or its size doesn't match bundle.json.`);
  }
  const packs = Array.isArray(manifest?.packs) ? manifest.packs : [];
  for (const pkg of expected) {
    const pack = packs.find((entry) => entry.package === pkg.id);
    if (!pkg.redistributable) {
      if (pack)
        problems.push(`"${pkg.id}" (${pkg.contents}) may not be redistributed; remove its pack.`);
      continue;
    }
    if (!pack) {
      problems.push(`No pack for "${pkg.id}" (${pkg.contents}).`);
      continue;
    }
    if (pack.revision !== pkg.revision) {
      problems.push(
        `The "${pkg.id}" pack is revision ${pack.revision}; the app expects ${pkg.revision}.`,
      );
    }
    if (!safeRelative(pack.file) || !SHA256.test(pack.sha256 ?? "")) {
      problems.push(`The "${pkg.id}" pack has an invalid file name or checksum.`);
    } else if (fileSize(pack.file) !== pack.size) {
      problems.push(`${pack.file} is missing or its size doesn't match bundle.json.`);
    }
    if (!pack.license) problems.push(`The "${pkg.id}" pack has no licence note.`);
  }
  for (const pack of packs) {
    if (!expected.some((pkg) => pkg.id === pack.package)) {
      problems.push(`bundle.json lists "${pack.package}", which the app doesn't know.`);
    }
  }
  return problems;
}

/** The notices file: one line per third-party package, grouped under the pack that carries it. */
export function noticesText(sections) {
  const lines = [
    "OpenMind Studio — offline language server bundle: third-party components",
    "",
    "Each component keeps its own licence; the licence texts are inside each pack",
    "(node_modules/<package>/LICENSE*) and next to node.exe (lsp/node/LICENSE).",
    "",
  ];
  for (const section of sections) {
    lines.push(`== ${section.title} ==`);
    for (const item of [...section.items].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(
        `${item.name}${item.version ? `@${item.version}` : ""}  ${item.license || "UNKNOWN"}`,
      );
    }
    lines.push("");
  }
  return lines.join("\r\n");
}

/** A licence field from package.json (`"MIT"`, `{type}`, or the old `licenses` array). */
export function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((entry) => entry?.type ?? String(entry)).join(" OR ");
  }
  return "";
}
