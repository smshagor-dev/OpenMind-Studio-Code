// usage: node scripts/verify-architecture.mjs [<release folder>]   (default: release/v<version> of this project)
// Checks that each release file holds a program for the architecture its name says (`_x64` / `_x86`):
//   portable .zip   -> OpenMindStudio.exe inside: PE machine 0x8664 (x64) / 0x14c (x86)
//   .AppImage        -> its ELF header (the AppImage runtime): x86-64 / i386
//   _portable.tar.gz -> OpenMindStudio inside: ELF machine
//   .deb             -> control file `Architecture: amd64 | i386` and the packaged usr/bin binary's ELF machine
// The NSIS setup and the MSI are reported as not inspected: the NSIS stub is a 32-bit program for both architectures and
// the MSI's cabinet needs Windows Installer (check them with `msiexec /a`, see docs/release.md). Uses only node:zlib.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { releaseDir, releaseKindOf } from "./releaseTools.mjs";
import { zipEntry } from "./zipRead.mjs";

export { zipEntry };

const PE = { 0x8664: "x64", 0x14c: "x86" };
const ELF = { 0x3e: "x64", 0x03: "x86" };

export function peArch(bytes) {
  if (bytes.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = bytes.readUInt32LE(0x3c);
  return PE[bytes.readUInt16LE(pe + 4)] ?? null;
}

export function elfArch(bytes) {
  if (bytes.readUInt32BE(0) !== 0x7f454c46) return null;
  return ELF[bytes.readUInt16LE(18)] ?? null;
}

/** The members of a ustar/GNU tar archive: `{ name, data }`. */
export function tarEntries(tar) {
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start, length) => header.subarray(start, start + length).toString("latin1").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const data = tar.subarray(offset + 512, offset + 512 + size);
    if (type === "L") longName = data.toString("latin1").replace(/\0.*$/s, "");
    else entries.push({ name: name.replace(/^\.\//, ""), type, data });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** The members of a Unix `ar` archive (a .deb). */
export function arEntries(ar) {
  if (ar.subarray(0, 8).toString("latin1") !== "!<arch>\n") throw new Error("not an ar archive");
  const entries = [];
  let offset = 8;
  while (offset + 60 <= ar.length) {
    const name = ar.subarray(offset, offset + 16).toString("latin1").trim().replace(/\/$/, "");
    const size = parseInt(ar.subarray(offset + 48, offset + 58).toString("latin1").trim(), 10);
    entries.push({ name, data: ar.subarray(offset + 60, offset + 60 + size) });
    offset += 60 + size + (size % 2);
  }
  return entries;
}

function debArch(bytes) {
  const members = arEntries(bytes);
  const control = members.find((m) => m.name.startsWith("control.tar"));
  const data = members.find((m) => m.name.startsWith("data.tar"));
  if (!control?.name.endsWith(".gz") || !data?.name.endsWith(".gz")) {
    throw new Error(`unsupported deb compression (${control?.name}, ${data?.name})`);
  }
  const fields = tarEntries(gunzipSync(control.data)).find((e) => e.name === "control")?.data.toString("utf8") ?? "";
  const declared = { amd64: "x64", i386: "x86" }[/^Architecture:\s*(\S+)/m.exec(fields)?.[1] ?? ""] ?? null;
  const binary = tarEntries(gunzipSync(data.data)).find((e) => /^usr\/bin\/[^/]+$/.test(e.name) && e.type === "0");
  return { declared, binary: binary ? elfArch(binary.data) : null };
}

/** `{ name, expected, found, ok, note }` for one release file. */
export function inspectFile(path, name) {
  const kind = releaseKindOf(name);
  const expected = /_(x64|x86)[._]/.exec(name)?.[1] ?? null;
  if (kind === "setup" || kind === "msi") {
    return { name, expected, found: null, ok: true, note: "not inspected (installer; see docs/release.md)" };
  }
  const bytes = readFileSync(path);
  let found = null;
  let note = "";
  if (kind === "portable") {
    const exe = zipEntry(bytes, (n) => n.endsWith("/OpenMindStudio.exe"));
    found = exe ? peArch(exe.data) : null;
    note = exe ? exe.name : "OpenMindStudio.exe missing";
  } else if (kind === "appimage") {
    found = elfArch(bytes);
    note = "AppImage runtime";
  } else if (kind === "linux-portable") {
    const program = tarEntries(gunzipSync(bytes)).find((e) => e.name.endsWith("/OpenMindStudio"));
    found = program ? elfArch(program.data) : null;
    note = program ? `${program.name}` : "OpenMindStudio missing";
  } else if (kind === "deb") {
    const { declared, binary } = debArch(bytes);
    found = declared === binary ? declared : null;
    note = `Architecture ${declared ?? "?"}, usr/bin binary ${binary ?? "?"}`;
  }
  return { name, expected, found, ok: found !== null && found === expected, note };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const version = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
  const dir = resolve(process.argv[2] ?? releaseDir(root, version));
  let failures = 0;
  for (const platform of ["windows", "linux"]) {
    for (const name of readdirSync(join(dir, platform)).sort()) {
      if (releaseKindOf(name) === null) continue;
      const result = inspectFile(join(dir, platform, name), name);
      if (!result.ok) failures += 1;
      console.log(`${result.ok ? "OK  " : "FAIL"} ${platform}/${name}: ${result.found ?? "-"} (${result.note})`);
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}
