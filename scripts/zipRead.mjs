// Reading ZIP archives in memory with node:zlib only (no dependency): the central directory, stored or deflated entries.
// Used by the release checks (verify-architecture.mjs) and the licence notices (third-party-licenses.mjs).
import { inflateRawSync } from "node:zlib";

/** Every entry of a ZIP: `{ name, data() }` (`data` inflates on demand). Throws when `zip` is not a ZIP archive. */
export function zipEntries(zip) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("not a ZIP archive");
  const entries = [];
  let offset = zip.readUInt32LE(end + 16);
  const count = zip.readUInt16LE(end + 10);
  for (let i = 0; i < count; i += 1) {
    const method = zip.readUInt16LE(offset + 10);
    const compressed = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extra = zip.readUInt16LE(offset + 30);
    const comment = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    entries.push({
      name,
      data() {
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const raw = zip.subarray(start, start + compressed);
        return method === 0 ? raw : inflateRawSync(raw);
      },
    });
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}

/** The first entry whose name satisfies `wanted`, as `{ name, data }`, or null. */
export function zipEntry(zip, wanted) {
  const entry = zipEntries(zip).find((e) => wanted(e.name));
  return entry ? { name: entry.name, data: entry.data() } : null;
}
