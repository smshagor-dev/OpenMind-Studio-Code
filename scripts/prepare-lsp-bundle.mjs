// Builds the offline language server bundle that release builds ship next to the executable as `lsp/`
// (see crates/lsp/src/bundle.rs and docs/lsp-bundle.md). This is the ONLY place anything is downloaded
// for it: the app itself never fetches a language server.
//
//   pnpm lsp:bundle               download (cached), verify and pack everything into lsp-bundle/
//   pnpm lsp:bundle -- --only yaml,rust   rebuild some packs, keep the others
//   pnpm lsp:bundle -- --check    verify an existing lsp-bundle/ (sizes and SHA256) without changing it
//
// A package whose licence forbids redistribution (Intelephense) is never packed; the app offers it as a
// user-initiated npm install instead.
//
// npm packages are installed with `npm ci --ignore-scripts` from the lockfiles pinned in crates/lsp/servers/<id>/
// (every file checked against its integrity hash). Node.js and the native servers come from the URLs pinned with
// SHA256 in crates/lsp/servers/bundle-sources.json; a mismatch stops the build.
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  bundleManifest,
  licenseOf,
  noticesText,
  packFileName,
  strippedName,
  validateLspBundle,
} from "./lspBundle.mjs";

const root = resolve(import.meta.dirname, "..");
// lsp-bundle/ holds only what ships (Tauri copies the whole folder into the installers as lsp/);
// downloads, npm's cache and build folders live beside it in .lsp-bundle-cache/.
const out = join(root, "lsp-bundle");
const cache = join(root, ".lsp-bundle-cache");
const downloads = join(cache, "downloads");
const work = join(cache, "work");
const noticesCache = join(cache, "notices.json");
const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? new Set((args[onlyIndex + 1] ?? "").split(",")) : null;
const sources = JSON.parse(
  readFileSync(join(root, "crates/lsp/servers/bundle-sources.json"), "utf8"),
);

/** Runs the Rust helper (the same checked zip code the app uses). */
function tool(...toolArgs) {
  return execFileSync(
    "cargo",
    ["run", "--release", "-q", "-p", "openmind-lsp", "--example", "bundle_tool", "--", ...toolArgs],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Downloads `url` into the cache once; the file must have the pinned SHA256. */
async function download(url, sha) {
  mkdirSync(downloads, { recursive: true });
  const target = join(downloads, basename(new URL(url).pathname));
  if (existsSync(target) && (await sha256(target)) === sha) return target;
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const part = `${target}.part`;
  writeFileSync(part, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256(part);
  if (actual !== sha) {
    rmSync(part, { force: true });
    throw new Error(`${url}: SHA256 ${actual}, pinned ${sha}. Nothing was used.`);
  }
  renameSync(part, target);
  return target;
}

function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** name@version and licence of every npm package installed under `dir`. */
function npmLicenses(dir) {
  // A package's own manifest: node_modules/<name>/package.json or node_modules/@scope/<name>/package.json.
  const isPackageManifest = (file) => {
    const parts = relative(dir, file).split(/[\\/]/);
    const n = parts.length;
    return (
      parts[n - 1] === "package.json" &&
      (parts[n - 3] === "node_modules" ||
        (parts[n - 4] === "node_modules" && parts[n - 3].startsWith("@")))
    );
  };
  return filesUnder(join(dir, "node_modules"))
    .filter(isPackageManifest)
    .map((file) => JSON.parse(readFileSync(file, "utf8")))
    .filter((pkg) => typeof pkg.name === "string" && typeof pkg.version === "string")
    .map((pkg) => ({ name: pkg.name, version: pkg.version, license: licenseOf(pkg) }))
    .filter(
      (item, index, all) =>
        all.findIndex((other) => other.name === item.name && other.version === item.version) ===
        index,
    );
}

function packInto(pkg, folder) {
  mkdirSync(join(out, "packs"), { recursive: true });
  const file = packFileName(pkg.id, pkg.revision);
  const tmp = join(out, `${file}.tmp`);
  const made = JSON.parse(tool("pack", pkg.id, folder, tmp));
  renameSync(tmp, join(out, file));
  console.log(`  ${file}: ${(made.size / 1048576).toFixed(1)} MB, ${made.files} files`);
  return { file, sha256: made.sha256, size: made.size };
}

function buildNpm(pkg) {
  const folder = join(work, pkg.id);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    copyFileSync(join(root, "crates/lsp/servers", pkg.id, name), join(folder, name));
  }
  console.log(`npm ci for ${pkg.contents}`);
  execSync("npm ci --ignore-scripts --no-audit --no-fund --no-progress --loglevel=error", {
    cwd: folder,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_cache: join(downloads, "npm"),
      npm_config_update_notifier: "false",
    },
  });
  const items = npmLicenses(folder);
  const main = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).dependencies;
  const license = Object.keys(main)
    .map((name) => `${name}: ${items.find((item) => item.name === name)?.license || "UNKNOWN"}`)
    .join("; ");
  return { ...packInto(pkg, folder), license, notices: { title: pkg.contents, items } };
}

async function buildNative(pkg) {
  const source = sources.native.find((entry) => entry.package === pkg.id);
  if (!source) throw new Error(`bundle-sources.json has no entry for native package "${pkg.id}".`);
  const archive = await download(source.url, source.sha256);
  const raw = join(work, `${pkg.id}.raw`);
  const folder = join(work, pkg.id);
  for (const dir of [raw, folder]) rmSync(dir, { recursive: true, force: true });
  tool("extract", archive, raw);
  for (const file of filesUnder(raw)) {
    const kept = strippedName(relative(raw, file), source.stripComponents, source.skip);
    if (kept === null || (source.only && !source.only.includes(kept))) continue;
    mkdirSync(dirname(join(folder, kept)), { recursive: true });
    copyFileSync(file, join(folder, kept));
  }
  writeFileSync(
    join(folder, "LICENSE-NOTICE.txt"),
    `${source.contents}\r\nLicence: ${source.license}\r\nSource: ${source.url}\r\nSHA256: ${source.sha256}\r\n`,
  );
  rmSync(raw, { recursive: true, force: true });
  return {
    ...packInto(pkg, folder),
    license: source.license,
    notices: {
      title: source.contents,
      items: [{ name: pkg.contents, version: "", license: source.license }],
    },
  };
}

async function buildNode() {
  const node = sources.node;
  const archive = await download(node.url, node.sha256);
  const raw = join(work, "node.raw");
  rmSync(raw, { recursive: true, force: true });
  tool("extract", archive, raw);
  const target = join(out, "node");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const keep of node.keep) copyFileSync(join(raw, keep), join(target, basename(keep)));
  rmSync(raw, { recursive: true, force: true });
  const exe = join(target, "node.exe");
  return {
    version: node.version,
    path: "node/node.exe",
    sha256: await sha256(exe),
    size: statSync(exe).size,
    license: node.license,
  };
}

function fileSize(relativePath) {
  const path = join(out, ...relativePath.split("/"));
  return existsSync(path) ? statSync(path).size : null;
}

async function check(expected) {
  const manifestPath = join(out, "bundle.json");
  if (!existsSync(manifestPath))
    throw new Error("lsp-bundle/bundle.json is missing. Run pnpm lsp:bundle first.");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problems = validateLspBundle(manifest, expected, fileSize);
  if (problems.length === 0) {
    for (const entry of [manifest.node, ...manifest.packs]) {
      const path = join(out, ...(entry.path ?? entry.file).split("/"));
      if ((await sha256(path)) !== entry.sha256)
        problems.push(`${entry.path ?? entry.file}: SHA256 mismatch.`);
    }
  }
  if (problems.length > 0) throw new Error(`lsp-bundle/ is not ready:\n  ${problems.join("\n  ")}`);
  const total = [manifest.node, ...manifest.packs].reduce((sum, entry) => sum + entry.size, 0);
  console.log(
    `lsp-bundle/ is complete: ${manifest.packs.length} packs + Node.js ${manifest.node.version}, ` +
      `${(total / 1048576).toFixed(1)} MB.`,
  );
}

async function main() {
  const expected = JSON.parse(tool("packages"));
  if (args.includes("--check")) return check(expected);
  mkdirSync(work, { recursive: true });
  const previous = existsSync(join(out, "bundle.json"))
    ? JSON.parse(readFileSync(join(out, "bundle.json"), "utf8"))
    : null;
  const previousNotices = existsSync(noticesCache)
    ? JSON.parse(readFileSync(noticesCache, "utf8"))
    : {};
  const packs = [];
  const notices = Object.fromEntries(
    Object.entries(previousNotices).filter(([id]) =>
      expected.some((pkg) => pkg.id === id && pkg.redistributable),
    ),
  );
  for (const pkg of expected) {
    if (!pkg.redistributable) {
      console.log(`Skipping ${pkg.contents}: its licence doesn't allow redistribution.`);
      continue;
    }
    const reuse =
      only &&
      !only.has(pkg.id) &&
      previous?.packs.find((pack) => pack.package === pkg.id && pack.revision === pkg.revision);
    if (reuse) {
      packs.push(reuse);
      continue;
    }
    const built = pkg.native ? await buildNative(pkg) : buildNpm(pkg);
    notices[pkg.id] = built.notices;
    packs.push({
      package: pkg.id,
      revision: pkg.revision,
      contents: pkg.contents,
      file: built.file,
      sha256: built.sha256,
      size: built.size,
      license: built.license,
    });
  }
  const node = only && !only.has("node") && previous?.node ? previous.node : await buildNode();
  writeFileSync(noticesCache, `${JSON.stringify(notices, null, 2)}\n`);
  writeFileSync(
    join(out, "THIRD-PARTY-NOTICES.txt"),
    noticesText([
      {
        title: `Node.js ${node.version}`,
        items: [{ name: "node", version: node.version, license: node.license }],
      },
      ...expected
        .filter((pkg) => pkg.redistributable)
        .map((pkg) => notices[pkg.id])
        .filter(Boolean),
    ]),
  );
  const manifest = bundleManifest({ createdAt: new Date().toISOString(), node, packs });
  writeFileSync(join(out, "bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(work, { recursive: true, force: true });
  await check(expected);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
