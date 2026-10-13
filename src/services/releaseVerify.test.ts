/// <reference types="node" />
// The release verifiers: update signatures (scripts/verify-updater-signatures.mjs) and architectures
// (scripts/verify-architecture.mjs).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { elfArch, inspectFile, peArch, tarEntries } from "../../scripts/verify-architecture.mjs";
import { publicKey, verifySignature } from "../../scripts/verify-updater-signatures.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = join(root, "src-tauri", "src", "updates", "fixtures");
const tauri = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")) as {
  plugins: { updater: { pubkey: string } };
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("update signature verifier", () => {
  const payload = readFileSync(join(fixtures, "payload.bin"));
  const sig = readFileSync(join(fixtures, "payload.v1.2.3.sig"), "utf8");
  const testKey = publicKey(readFileSync(join(fixtures, "test.key.pub"), "utf8"));

  it("accepts the signed file and reads the version it was bound to", () => {
    expect(verifySignature(payload, sig, testKey)).toBe("1.2.3");
    expect(verifySignature(payload, readFileSync(join(fixtures, "payload.unversioned.sig"), "utf8"), testKey)).toBeNull();
  });

  it("refuses a changed byte, another key and a changed trusted comment", () => {
    const tampered = Buffer.from(payload);
    const middle = Math.floor(tampered.length / 2);
    tampered.writeUInt8(tampered.readUInt8(middle) ^ 1, middle);
    expect(() => verifySignature(tampered, sig, testKey)).toThrow(/doesn't match/);
    expect(() => verifySignature(payload, sig, publicKey(tauri.plugins.updater.pubkey))).toThrow(/another key/);
    const lines = Buffer.from(sig.trim(), "base64").toString("utf8").split("\n");
    lines[2] = (lines[2] ?? "").replace("1.2.3", "9.9.9");
    const replayed = Buffer.from(lines.join("\n"), "utf8").toString("base64");
    expect(() => verifySignature(payload, replayed, testKey)).toThrow(/trusted comment/);
  });

  it("reads OpenMind's release key from tauri.conf.json (key id 7A590C4E7142F2CF)", () => {
    const key = publicKey(tauri.plugins.updater.pubkey);
    expect(Buffer.from(key.keyId).reverse().toString("hex").toUpperCase()).toBe("7A590C4E7142F2CF");
  });
});

describe("architecture verifier", () => {
  const pe = (machine: number) => {
    const bytes = Buffer.alloc(0x100);
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.writeUInt32BE(0x50450000, 0x80);
    bytes.writeUInt16LE(machine, 0x84);
    return bytes;
  };
  const elf = (machine: number) => {
    const bytes = Buffer.alloc(64);
    bytes.writeUInt32BE(0x7f454c46, 0);
    bytes.writeUInt16LE(machine, 18);
    return bytes;
  };
  const tar = (name: string, data: Buffer) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, "latin1");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    header.write("0", 156, "latin1");
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]);
  };

  it("reads PE and ELF machines", () => {
    expect(peArch(pe(0x8664))).toBe("x64");
    expect(peArch(pe(0x14c))).toBe("x86");
    expect(elfArch(elf(0x3e))).toBe("x64");
    expect(elfArch(elf(0x03))).toBe("x86");
    expect(elfArch(pe(0x8664))).toBeNull();
  });

  it("finds the program in a portable tar.gz and refuses a relabelled one", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-arch-"));
    dirs.push(dir);
    const archive = gzipSync(tar("OpenMind Studio/OpenMindStudio", elf(0x3e)));
    expect(tarEntries(tar("a/b", Buffer.from("x"))).map((entry) => entry.name)).toEqual(["a/b"]);
    const good = join(dir, "OpenMind-Studio_1.0.3_linux_x64_portable.tar.gz");
    writeFileSync(good, archive);
    expect(inspectFile(good, "OpenMind-Studio_1.0.3_linux_x64_portable.tar.gz")).toMatchObject({ ok: true, found: "x64" });
    const relabelled = join(dir, "OpenMind-Studio_1.0.3_linux_x86_portable.tar.gz");
    writeFileSync(relabelled, archive);
    expect(inspectFile(relabelled, "OpenMind-Studio_1.0.3_linux_x86_portable.tar.gz")).toMatchObject({
      ok: false,
      expected: "x86",
      found: "x64",
    });
  });

  it("says plainly that installers are not inspected", () => {
    expect(inspectFile("unused", "OpenMind-Studio_1.0.3_windows_x86_setup.exe").note).toMatch(/not inspected/);
  });
});
