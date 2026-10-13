// usage: node scripts/third-party-licenses.mjs [--out <file>] [--check]
// Writes the licence notices of everything third-party that OpenMind Studio's packages contain into one text file
// (default licenses/THIRD-PARTY-LICENSES.txt, git-ignored; tauri.conf.json ships it as a resource):
//   1. Rust crates compiled into the program (cargo metadata; the LICENSE/COPYING/NOTICE files of each crate's source),
//   2. npm production packages bundled into the frontend (pnpm licenses list --prod; each package's licence files),
//   3. the Python wheels of python-bundle/packages.zip (their *.dist-info licence files and declared licence),
//      plus Tcl/Tk (python.org's tcltk.msi), when the Python bundle is present,
//   4. the offline language-server bundle's notices (lsp-bundle/THIRD-PARTY-NOTICES.txt), when present.
// Identical licence texts are printed once with every component that uses them. A component whose licence text can't
// be found is listed under "Licence text not found" (and --check then exits 1), never silently left out.
// It reads only local files (the cargo registry and node_modules already on disk); nothing is downloaded.
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zipEntries } from "./zipRead.mjs";

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense|authors)([-._].*)?$/i;

/** The licence-like files directly in `dir` (not in sub-folders), as `[{ file, text }]`. */
export function licenseFilesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ file: name, text: readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n").trim() }));
}

/** Groups components `{ name, license, texts: [{ file, text }] }` by identical licence text. Pure. */
export function groupByText(components) {
  const groups = new Map();
  const missing = [];
  for (const component of components) {
    if (component.texts.length === 0) {
      missing.push(component);
      continue;
    }
    for (const { text } of component.texts) {
      const key = createHash("sha256").update(text).digest("hex");
      if (!groups.has(key)) groups.set(key, { text, users: [] });
      const users = groups.get(key).users;
      if (!users.includes(component.name)) users.push(component.name);
    }
  }
  return { groups: [...groups.values()], missing };
}

/** The notices text for `sections` = `[{ title, intro, components }]` and `appendix` blocks. Pure. */
export function noticesText(sections, appendix = []) {
  const out = [
    "OpenMind Studio — third-party licences",
    "",
    "OpenMind Studio is licensed under the Apache License 2.0 (LICENSE). It contains the third-party components listed",
    "below, each under its own licence, reproduced here as their authors require. Adopting Apache-2.0 for OpenMind",
    "Studio's own code does not change the licence of any of them.",
    "",
  ];
  let missingTotal = 0;
  for (const section of sections) {
    const { groups, missing } = groupByText(section.components);
    missingTotal += missing.length;
    out.push("=".repeat(100), section.title, "=".repeat(100), "");
    if (section.intro) out.push(section.intro, "");
    out.push("Components:");
    for (const c of [...section.components].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`  ${c.name}  (${c.license || "licence not declared"})`);
    }
    out.push("");
    for (const group of groups) {
      out.push("-".repeat(100), `Used by: ${group.users.join(", ")}`, "-".repeat(100), group.text, "");
    }
    if (missing.length > 0) {
      out.push("Licence text not found (declared licence above; see the component's own source):");
      for (const c of missing) out.push(`  ${c.name}  (${c.license || "licence not declared"})`);
      out.push("");
    }
  }
  for (const block of appendix) out.push("=".repeat(100), block.title, "=".repeat(100), "", block.text.trim(), "");
  return { text: `${out.join("\n")}\n`, missing: missingTotal };
}

/** The release targets: only crates built for one of them are in the packages. */
const TARGETS = ["x86_64-pc-windows-msvc", "i686-pc-windows-msvc", "x86_64-unknown-linux-gnu", "i686-unknown-linux-gnu"];

/** The package ids reachable from the workspace through normal and build dependencies (not dev-only ones). Pure. */
export function shippedPackageIds(meta) {
  const nodes = new Map(meta.resolve.nodes.map((node) => [node.id, node]));
  const seen = new Set();
  const stack = [...meta.workspace_members];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      const kinds = dep.dep_kinds ?? [];
      if (kinds.length === 0 || kinds.some((k) => k.kind !== "dev")) stack.push(dep.pkg);
    }
  }
  return seen;
}

/**
 * The SPDX ids whose text a component needs when it ships no licence file: every id of an AND expression, else the
 * first id of an OR expression that has a text here (one licence of a choice is enough). Pure.
 */
export function fallbackIds(expression, available) {
  const ids = (expression.match(/[A-Za-z0-9.+-]+/g) ?? []).filter(
    (word) => !["AND", "OR", "WITH", "LLVM-exception"].includes(word),
  );
  const normalized = ids.map((id) => (id === "Apache-2.0" ? "Apache-2.0" : id.replace(/\+$/, "")));
  if (/\bAND\b/.test(expression)) return normalized.filter((id) => available.has(id));
  const chosen = normalized.find((id) => available.has(id));
  return chosen ? [chosen] : [];
}

function spdxTexts(root) {
  const texts = new Map([["Apache-2.0", readFileSync(join(root, "LICENSE"), "utf8").replace(/\r\n/g, "\n").trim()]]);
  const dir = join(root, "licenses", "spdx");
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    if (file !== "SOURCE.txt" && file.endsWith(".txt")) {
      texts.set(file.slice(0, -4), readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trim());
    }
  }
  return texts;
}

/** Fills in the SPDX text of the declared licence for components without a licence file of their own. */
export function withFallbackTexts(components, spdx) {
  return components.map((c) => {
    if (c.texts.length > 0) return c;
    const ids = fallbackIds(c.license ?? "", spdx);
    return {
      ...c,
      texts: ids.map((id) => ({
        file: `SPDX ${id}`,
        text: `[${id} — standard text from the SPDX License List; the component's package has no licence file]\n\n${spdx.get(id)}`,
      })),
    };
  });
}

function rustComponents(root) {
  const metadata = (target) =>
    JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", target], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }),
    );
  const packages = new Map();
  for (const target of TARGETS) {
    const meta = metadata(target);
    const members = new Set(meta.workspace_members);
    const shipped = shippedPackageIds(meta);
    for (const p of meta.packages) if (shipped.has(p.id) && !members.has(p.id)) packages.set(p.id, p);
  }
  return [...packages.values()]
    .map((p) => {
      const dir = dirname(p.manifest_path);
      const texts = licenseFilesIn(dir);
      if (p.license_file && existsSync(join(dir, p.license_file)) && !texts.some((t) => t.file === p.license_file)) {
        texts.push({ file: p.license_file, text: readFileSync(join(dir, p.license_file), "utf8").trim() });
      }
      return { name: `${p.name} ${p.version}`, license: p.license ?? "", texts };
    });
}

function npmComponents(root) {
  // A fixed command line (nothing user-supplied), through the shell so it finds pnpm.cmd on Windows.
  const raw = execSync("pnpm licenses list --prod --json", {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const byLicense = JSON.parse(raw);
  const components = [];
  for (const [license, packages] of Object.entries(byLicense)) {
    for (const pkg of packages) {
      const paths = pkg.paths ?? [];
      components.push({
        name: `${pkg.name} ${(pkg.versions ?? []).join(", ")}`,
        license,
        texts: paths.flatMap((path) => licenseFilesIn(path)).filter((t, i, all) => all.findIndex((x) => x.text === t.text) === i),
      });
    }
  }
  return components;
}

function pythonComponents(root) {
  const zip = join(root, "python-bundle", "packages.zip");
  if (!existsSync(zip)) return null;
  const components = [];
  for (const wheel of zipEntries(readFileSync(zip)).filter((e) => e.name.endsWith(".whl"))) {
    const entries = zipEntries(wheel.data());
    const meta = entries.find((e) => /^[^/]+\.dist-info\/METADATA$/.test(e.name));
    const fields = meta ? meta.data().toString("utf8").split(/\r?\n\r?\n/)[0] : "";
    const field = (key) => new RegExp(`^${key}: (.+)$`, "m").exec(fields)?.[1]?.trim();
    const classifiers = [...fields.matchAll(/^Classifier: License :: (.+)$/gm)].map((m) => m[1].trim());
    // License-Expression (SPDX) first; else the trove classifiers; the free-text License field only when it is a short
    // name (some packages put their whole licence text there).
    const short = field("License");
    const license =
      field("License-Expression") ??
      (classifiers.length > 0 ? classifiers.join("; ") : null) ??
      (short && short.length < 60 && /^[A-Za-z]/.test(short) ? short : "");
    const texts = entries
      .filter((e) => /^[^/]+\.dist-info\/(licenses\/)?(.*\/)?[^/]*(LICEN[CS]E|COPYING|NOTICE|AUTHORS)[^/]*$/i.test(e.name))
      .map((e) => ({ file: e.name, text: e.data().toString("utf8").replace(/\r\n/g, "\n").trim() }));
    components.push({ name: `${field("Name") ?? wheel.name} ${field("Version") ?? ""}`.trim(), license, texts });
  }
  return components;
}

const TCLTK = `Tcl/Tk (python.org's tcltk.msi for CPython, installed by the Runtime Manager's "Tcl/Tk GUI support" add-on) is
distributed under the Tcl/Tk licence (BSD-style): https://www.tcl-lang.org/software/tcltk/license.html. The licence terms
are also installed with it (tcl/tcl9.0 and tcl/tk9.0 "license.terms").`;

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const at = args.indexOf("--out");
  const out = resolve(root, at >= 0 ? args[at + 1] : join("licenses", "THIRD-PARTY-LICENSES.txt"));
  const spdx = spdxTexts(root);
  const sections = [
    {
      title: "Rust crates (compiled into OpenMindStudio.exe / OpenMindStudio)",
      components: withFallbackTexts(rustComponents(root), spdx),
    },
    {
      title: "JavaScript packages (bundled into the user interface)",
      components: withFallbackTexts(npmComponents(root), spdx),
    },
  ];
  const pythonRaw = pythonComponents(root);
  const python = pythonRaw ? withFallbackTexts(pythonRaw, spdx) : null;
  const appendix = [];
  if (python) {
    sections.push({
      title: "Python packages of the offline Python bundle (python-bundle/, Windows builds)",
      intro:
        "Installed into OpenMind's portable Python on request. Packages under the LGPL (e.g. python-telegram-bot, and the\n" +
        "FFmpeg/Qt libraries inside opencv-python) are unmodified; their source is available from PyPI and the projects named.",
      components: python,
    });
    appendix.push({ title: "Tcl/Tk", text: TCLTK });
  }
  const lspNotices = join(root, "lsp-bundle", "THIRD-PARTY-NOTICES.txt");
  if (existsSync(lspNotices)) {
    appendix.push({
      title: "Offline language servers and formatters (lsp/, Windows builds)",
      text:
        `${readFileSync(lspNotices, "utf8")}\nEach pack keeps its packages' own licence files (node_modules/*/LICENSE). ` +
        "The bundled Node.js (lsp/node/node.exe) ships with its licence, including the licences of the libraries it " +
        "contains, in lsp/node/LICENSE.",
    });
  }
  const { text, missing } = noticesText(sections, appendix);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  const count = sections.reduce((n, s) => n + s.components.length, 0);
  console.log(`Wrote ${out}: ${count} components, ${(text.length / 1024).toFixed(0)} KB, ${missing} without a licence file.`);
  if (args.includes("--check") && missing > 0) process.exit(1);
}
