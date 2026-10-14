// Authenticode signing workflow (scripts/authenticodeTools.mjs, scripts/authenticodeRelease.mjs).
// MOCK-BASED: SignTool, the certificate store and the files are fakes, so these tests run anywhere without a
// certificate. They prove the rules and the order of operations, not that Windows accepts a real signature — that is
// checked by hand with a real certificate (docs/code-signing.md, "Verifying a signed release").
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AuthenticodeEffects, SigningCertificate } from "../../scripts/authenticodeRelease.mjs";
import { runAuthenticodeRelease, windowsFiles } from "../../scripts/authenticodeRelease.mjs";
import {
  certificateVerdict,
  classifySigntoolFailure,
  CODE_SIGNING_EKU,
  compareTrees,
  findSigntoolIn,
  planArtifact,
  RSA_OID,
  signtoolSignArgs,
} from "../../scripts/authenticodeTools.mjs";

const THUMB = "352ED3665AF5E1E59278F1E7ABF463F9BA4FE8EC";
const OTHER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const V = "1.0.4";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("SignTool discovery", () => {
  const kits = "C:\\PF86\\Windows Kits\\10\\bin";
  const fs = (present: string[]) => ({
    exists: (p: string) => p === kits || present.includes(p),
    list: () => ["10.0.9200.0", "10.0.26100.0", "10.0.14393.0", "wdf"],
  });

  it("picks the newest SDK version numerically, preferring the host architecture", () => {
    const found = findSigntoolIn({ "ProgramFiles(x86)": "C:\\PF86" }, fs([
      `${kits}\\10.0.9200.0\\x64\\signtool.exe`,
      `${kits}\\10.0.26100.0\\x86\\signtool.exe`,
      `${kits}\\10.0.26100.0\\x64\\signtool.exe`,
    ]));
    expect(found.path).toBe(`${kits}\\10.0.26100.0\\x64\\signtool.exe`);
  });

  it("missing SignTool is a clear problem, and SIGNTOOL_PATH must name an existing signtool.exe", () => {
    expect(findSigntoolIn({ "ProgramFiles(x86)": "C:\\PF86" }, fs([])).problem).toContain("Windows SDK");
    expect(findSigntoolIn({}, fs([])).problem).toContain("SIGNTOOL_PATH");
    expect(findSigntoolIn({ SIGNTOOL_PATH: "C:\\x\\evil.exe" }, fs(["C:\\x\\evil.exe"])).problem).toContain("signtool.exe");
    expect(findSigntoolIn({ SIGNTOOL_PATH: "C:\\x\\signtool.exe" }, fs([])).problem).toContain("doesn't exist");
    expect(findSigntoolIn({ SIGNTOOL_PATH: "C:\\x\\signtool.exe" }, fs(["C:\\x\\signtool.exe"])).path).toBe(
      "C:\\x\\signtool.exe",
    );
  });
});

describe("certificate checks", () => {
  const now = new Date("2026-10-14T00:00:00Z");
  const good = {
    found: true,
    thumbprint: THUMB,
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: "2027-06-01T00:00:00Z",
    hasPrivateKey: true,
    ekus: [CODE_SIGNING_EKU],
    keyAlgorithm: RSA_OID,
    chainTrusted: true,
    chainStatus: [],
  };

  it("a valid, trusted RSA code-signing certificate with its key passes", () => {
    expect(certificateVerdict(good, "signed", now)).toEqual({ problems: [], warnings: [] });
  });

  it("missing, expired, not yet valid, keyless or non-code-signing certificates are refused", () => {
    expect(certificateVerdict(null, "signed", now).problems[0]).toContain("not found");
    expect(certificateVerdict({ found: false, thumbprint: THUMB }, "signed", now).problems[0]).toContain(THUMB);
    expect(certificateVerdict({ ...good, notAfter: "2026-10-01T00:00:00Z" }, "signed", now).problems[0]).toContain("expired");
    expect(certificateVerdict({ ...good, notBefore: "2026-11-01T00:00:00Z" }, "signed", now).problems[0]).toContain("not valid yet");
    expect(certificateVerdict({ ...good, hasPrivateKey: false }, "signed", now).problems[0]).toContain("private key");
    expect(certificateVerdict({ ...good, ekus: ["1.3.6.1.5.5.7.3.1"] }, "signed", now).problems[0]).toContain("code-signing");
  });

  it("a release needs a trusted chain and an RSA key; a test certificate only gets warnings", () => {
    const untrusted = { ...good, chainTrusted: false, chainStatus: ["UntrustedRoot"] };
    expect(certificateVerdict(untrusted, "signed", now).problems[0]).toContain("Trusted Root Program");
    expect(certificateVerdict(untrusted, "test-signed", now)).toMatchObject({ problems: [] });
    expect(certificateVerdict(untrusted, "test-signed", now).warnings[0]).toContain("TEST");
    const ecc = { ...good, keyAlgorithm: "1.2.840.10045.2.1" };
    expect(certificateVerdict(ecc, "signed", now).problems[0]).toContain("Smart App Control");
    expect(certificateVerdict(ecc, "test-signed", now).problems).toEqual([]);
  });

  it("warns before expiry and about unchecked revocation", () => {
    expect(certificateVerdict({ ...good, notAfter: "2026-10-30T00:00:00Z" }, "signed", now).warnings[0]).toContain("expires");
    const offline = { ...good, chainStatus: ["RevocationStatusUnknown", "OfflineRevocation"] };
    expect(certificateVerdict(offline, "signed", now).warnings[0]).toContain("Revocation");
  });
});

describe("SignTool arguments and failures", () => {
  it("signs by thumbprint with SHA-256, an RFC 3161 SHA-256 timestamp and the description; never a password", () => {
    const args = signtoolSignArgs({ thumbprint: THUMB, timestampUrl: "http://ts.example" }, "a.exe");
    expect(args).toEqual([
      "sign", "/fd", "SHA256", "/sha1", THUMB, "/s", "My", "/tr", "http://ts.example", "/td", "SHA256", "/d", "OpenMind Studio", "a.exe",
    ]);
    expect(signtoolSignArgs({ thumbprint: THUMB, store: "machine" }, "a.exe")).toContain("/sm");
    expect(() => signtoolSignArgs({ thumbprint: "abc" }, "a.exe")).toThrow("thumbprint");
  });

  it("explains timestamp, certificate, key and locked-file failures", () => {
    expect(classifySigntoolFailure("SignTool Error: The specified timestamp server either could not be reached")).toContain("timestamp server");
    expect(classifySigntoolFailure("SignTool Error: No certificates were found that met all the given criteria.")).toContain("no matching certificate");
    expect(classifySigntoolFailure("SignTool Error: An unexpected internal error has occurred. Error information: \"Error: SignerSign() failed.\" (-2146893802/0x80090016) NTE_BAD_KEYSET")).toContain("private key");
    expect(classifySigntoolFailure("The process cannot access the file because it is being used by another process")).toContain("locked");
    expect(classifySigntoolFailure("SignTool Error: something else")).toContain("something else");
  });
});

describe("what happens to each file", () => {
  const opts = { thumbprint: THUMB };
  const unsigned = { status: "NotSigned", signerThumbprint: null };
  it("unsigned installers are refused unless --sign-installers-outer; a ZIP is repacked", () => {
    expect(planArtifact("setup", { exists: true, signature: unsigned, innerSignature: null }, opts).action).toBe("refuse");
    expect(planArtifact("setup", { exists: true, signature: unsigned, innerSignature: null }, { ...opts, signInstallersOuter: true }).action).toBe("sign");
    expect(planArtifact("portable", { exists: true, signature: null, innerSignature: unsigned }, opts).action).toBe("repack");
  });

  it("missing files, changed signed files and another certificate's signature are refused; our signature is kept", () => {
    expect(planArtifact("msi", { exists: false, signature: null, innerSignature: null }, opts)).toMatchObject({ action: "refuse", reason: "the file is missing" });
    expect(planArtifact("msi", { exists: true, signature: { status: "HashMismatch", signerThumbprint: THUMB }, innerSignature: null }, opts).reason).toContain("changed after it was signed");
    expect(planArtifact("msi", { exists: true, signature: { status: "Valid", signerThumbprint: OTHER }, innerSignature: null }, opts).reason).toContain("another certificate");
    expect(planArtifact("msi", { exists: true, signature: { status: "UnknownError", signerThumbprint: THUMB.toLowerCase() }, innerSignature: null }, opts).action).toBe("keep");
  });

  it("a rebuilt ZIP must equal the original except the signed program", () => {
    const before = { "a/x.exe": "1", "a/b.txt": "2" };
    expect(compareTrees(before, { "a/x.exe": "9", "a/b.txt": "2" }, ["a/x.exe"])).toEqual([]);
    expect(compareTrees(before, { "a/x.exe": "1", "a/b.txt": "2" }, ["a/x.exe"])[0]).toContain("not changed by signing");
    expect(compareTrees(before, { "a/x.exe": "9", "a/b.txt": "3" }, ["a/x.exe"])[0]).toContain("changed although");
    expect(compareTrees(before, { "a/x.exe": "9" }, ["a/x.exe"])[0]).toContain("missing after");
    expect(compareTrees(before, { ...before, "a/x.exe": "9", "a/new": "4" }, ["a/x.exe"])[0]).toContain("unexpected new entry");
  });
});

describe("the release signer works on the folder it was given", () => {
  const root = join(import.meta.dirname, "..", "..");

  it("passes that folder to every helper script (a test copy must never touch the real release folder)", () => {
    const cli = readFileSync(join(root, "scripts", "authenticode-release.mjs"), "utf8");
    const calls = cli.match(/node\("[a-z-]+\.mjs"[^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) expect(call, call).toContain("dir");
  });

  it("release-checksums --dir writes and checks the manifest of another folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-sums-"));
    try {
      mkdirSync(join(dir, "windows", "x64"), { recursive: true });
      writeFileSync(join(dir, "windows", "x64", `OpenMind-Studio_${V}_windows_x64_portable.zip`), "zip bytes");
      const script = join(root, "scripts", "release-checksums.mjs");
      execFileSync(process.execPath, [script, "--dir", dir], { stdio: "pipe" });
      const sums = readFileSync(join(dir, "metadata", "SHA256SUMS.txt"), "utf8");
      expect(sums).toContain(`${sha("zip bytes")}  OpenMind-Studio_${V}_windows_x64_portable.zip`);
      execFileSync(process.execPath, [script, "--verify", "--dir", dir], { stdio: "pipe" });
      writeFileSync(join(dir, "windows", "x64", `OpenMind-Studio_${V}_windows_x64_portable.zip`), "changed");
      expect(() => execFileSync(process.execPath, [script, "--verify", "--dir", dir], { stdio: "pipe" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** An in-memory release folder with fake SignTool, certificate, ZIP and updater signing. */
function world({ installersSigned = false } = {}) {
  const files = new Map<string, string>();
  const sigs = new Map<string, { status: string; signerThumbprint: string | null }>();
  const log: string[] = [];
  const calls = { sign: [] as string[], resign: 0, verify: 0, checksums: 0, zip: 0 };
  let temp = 0;
  const control = {
    signtool: null as string | null,
    cert: { thumbprint: THUMB, problems: [], warnings: [] } satisfies SigningCertificate as SigningCertificate,
    certThrows: null as string | null,
    updater: null as string | null,
    failSignOn: null as { match: string; reason: string } | null,
    dropOnZip: null as string | null,
    verify: null as string | null,
  };
  const zipOf = (tree: Record<string, string>) => `ZIP:${JSON.stringify(tree)}`;
  for (const arch of ["x64", "x86"]) {
    for (const f of windowsFiles(V, arch)) {
      if (f.kind === "portable") {
        files.set(f.path, zipOf({ "OpenMind Studio/OpenMindStudio.exe": `exe-${arch}`, "OpenMind Studio/lsp/node/node.exe": "node", "OpenMind Studio/README.txt": "readme" }));
      } else {
        files.set(f.path, `${f.kind}-${arch}`);
        if (installersSigned) sigs.set(f.path, { status: "Valid", signerThumbprint: THUMB });
      }
      files.set(`${f.path}.sig`, `sig:${sha(files.get(f.path) ?? "")}`);
    }
  }
  files.set("metadata/SHA256SUMS.txt", "sums-v1");
  files.set("metadata/latest.json", "feed-v1");
  const fx: AuthenticodeEffects = {
    log: (line) => log.push(line),
    signtoolProblem: () => control.signtool,
    withSigningCertificate: (fn) => {
      if (control.certThrows) throw new Error(control.certThrows);
      return fn(control.cert);
    },
    exists: (p) => files.has(p),
    signature: (p) => sigs.get(p) ?? { status: "NotSigned", signerThumbprint: null },
    sign: (p, cert) => {
      calls.sign.push(p);
      if (control.failSignOn && p.includes(control.failSignOn.match)) return control.failSignOn.reason;
      files.set(p, `${files.get(p) ?? ""}+signed`);
      sigs.set(p, { status: "Valid", signerThumbprint: cert.thumbprint });
      return null;
    },
    extract: (zip, dir) => {
      const tree = JSON.parse((files.get(zip) ?? "ZIP:{}").slice(4)) as Record<string, string>;
      for (const [name, content] of Object.entries(tree)) {
        files.set(`${dir}/${name}`, content);
        if (content.endsWith("+signed")) sigs.set(`${dir}/${name}`, { status: "Valid", signerThumbprint: THUMB });
      }
    },
    createZip: (base, folder, zip) => {
      calls.zip += 1;
      const tree: Record<string, string> = {};
      for (const [p, content] of files) {
        if (p.startsWith(`${base}/${folder}/`) && !(control.dropOnZip && p.endsWith(control.dropOnZip))) {
          tree[p.slice(base.length + 1)] = content;
        }
      }
      files.set(zip, zipOf(tree));
    },
    hashTree: (dir) =>
      Object.fromEntries([...files].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, c]) => [p.slice(dir.length + 1), sha(c)])),
    sha256: (p) => sha(files.get(p) ?? ""),
    tempDir: (prefix) => `/tmp/${prefix}-${(temp += 1)}`,
    copyFile: (from, to) => files.set(to, files.get(from) ?? ""),
    rename: (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
      const s = sigs.get(from);
      if (s) sigs.set(to, s);
    },
    remove: (p) => files.delete(p),
    removeTree: (dir) => {
      for (const p of [...files.keys()]) if (p.startsWith(`${dir}/`)) files.delete(p);
    },
    stamp: () => "T1",
    updaterProblem: () => control.updater,
    resignUpdater: () => {
      calls.resign += 1;
      for (const [p, c] of [...files]) if (/\.(exe|msi|zip)$/.test(p) && files.has(`${p}.sig`)) files.set(`${p}.sig`, `sig:${sha(c)}`);
      files.set("metadata/SHA256SUMS.txt", "sums-v2");
      files.set("metadata/latest.json", "feed-v2");
      return null;
    },
    writeChecksums: () => {
      calls.checksums += 1;
      files.set("metadata/SHA256SUMS.txt", "sums-v2");
      return null;
    },
    verifyRelease: () => {
      calls.verify += 1;
      return control.verify;
    },
  };
  const releaseFiles = () => Object.fromEntries([...files].filter(([p]) => !p.startsWith("/tmp") && !p.startsWith("validation/")));
  return { files, sigs, log, calls, control, fx, releaseFiles };
}

const run = (w: ReturnType<typeof world>, extra: Partial<Parameters<typeof runAuthenticodeRelease>[0]> = {}) =>
  runAuthenticodeRelease({ version: V, arches: ["x64", "x86"], ...extra }, w.fx);

describe("signing a release folder (mock-based)", () => {
  it("missing SignTool or certificate, an invalid certificate or a missing file blocks before anything changes", () => {
    for (const setup of [
      (w: ReturnType<typeof world>) => (w.control.signtool = "signtool.exe was not found"),
      (w: ReturnType<typeof world>) => (w.control.certThrows = "No signing certificate is configured"),
      (w: ReturnType<typeof world>) => (w.control.cert = { thumbprint: THUMB, problems: ["The certificate expired"], warnings: [] }),
      (w: ReturnType<typeof world>) => w.files.delete(`windows/x86/OpenMind-Studio_${V}_windows_x86.msi`),
    ]) {
      const w = world({ installersSigned: true });
      setup(w);
      const before = JSON.stringify(w.releaseFiles());
      const result = run(w);
      expect(result.ok).toBe(false);
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(JSON.stringify(w.releaseFiles())).toBe(before);
      expect(w.calls.sign).toEqual([]);
      expect([...w.files.keys()].some((p) => p.startsWith("validation/"))).toBe(false);
    }
  });

  it("dry run lists every file and changes nothing; unsigned installers are reported as needing a rebuild", () => {
    const w = world();
    const before = JSON.stringify(w.releaseFiles());
    const refused = run(w, { dryRun: true });
    expect(refused.ok).toBe(false);
    expect(w.log.join("\n")).toContain("built without Authenticode");
    const w2 = world();
    const planned = run(w2, { dryRun: true, signInstallersOuter: true });
    expect(planned.ok).toBe(true);
    expect(planned.steps.map((s) => s.action)).toEqual(["sign", "sign", "repack", "sign", "sign", "repack"]);
    expect(w2.log.join("\n")).toContain("nothing was changed");
    expect(JSON.stringify(w.releaseFiles())).toBe(before);
    expect(JSON.stringify(w2.releaseFiles())).toBe(before);
    expect(w2.calls.sign).toEqual([]);
    expect(w2.calls.resign).toBe(0);
  });

  it("signs, backs up first, regenerates the updater signatures and checksums once, and verifies", () => {
    const w = world({ installersSigned: true });
    const original = w.files.get(`windows/x64/OpenMind-Studio_${V}_windows_x64_portable.zip`);
    const result = run(w);
    expect(result.ok).toBe(true);
    expect(result.changed.map((c) => c.path)).toEqual([
      `windows/x64/OpenMind-Studio_${V}_windows_x64_portable.zip`,
      `windows/x86/OpenMind-Studio_${V}_windows_x86_portable.zip`,
    ]);
    for (const c of result.changed) expect(c.before).not.toBe(c.after);
    // the backup holds the original bytes and their old .sig, plus both manifests
    expect(w.files.get(`validation/pre-authenticode/T1/windows/x64/OpenMind-Studio_${V}_windows_x64_portable.zip`)).toBe(original);
    expect(w.files.get("validation/pre-authenticode/T1/metadata/SHA256SUMS.txt")).toBe("sums-v1");
    expect(w.calls.resign).toBe(1);
    expect(w.calls.verify).toBe(1);
    expect(w.files.get("metadata/SHA256SUMS.txt")).toBe("sums-v2");
    // only our program was signed (inside a temporary copy), never node.exe or the installers already signed
    expect(w.calls.sign.every((p) => p.endsWith("OpenMind Studio/OpenMindStudio.exe"))).toBe(true);
    // no stale application signature: every .sig matches its file's final bytes
    for (const [p, c] of w.files) {
      if (/\.(exe|msi|zip)$/.test(p) && !p.startsWith("validation/") && w.files.has(`${p}.sig`)) {
        expect(w.files.get(`${p}.sig`)).toBe(`sig:${sha(c)}`);
      }
    }
    expect([...w.files.keys()].some((p) => p.startsWith("/tmp"))).toBe(false);
  });

  it("a repeated run finds everything signed and changes nothing", () => {
    const w = world({ installersSigned: true });
    expect(run(w).ok).toBe(true);
    const after = JSON.stringify(w.releaseFiles());
    const signs = w.calls.sign.length;
    const again = run(w);
    expect(again.ok).toBe(true);
    expect(again.changed).toEqual([]);
    expect(again.steps.every((s) => s.action === "keep")).toBe(true);
    expect(w.calls.sign.length).toBe(signs);
    expect(w.calls.resign).toBe(1);
    expect(JSON.stringify(w.releaseFiles())).toBe(after);
  });

  it("a timestamp failure part-way puts every replaced file back and makes no updater signature", () => {
    const w = world({ installersSigned: true });
    const before = JSON.stringify(w.releaseFiles());
    w.control.failSignOn = { match: "portable-x86", reason: "The timestamp server could not be reached" };
    const result = run(w);
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toContain("timestamp");
    expect(w.calls.resign).toBe(0);
    expect(JSON.stringify(w.releaseFiles())).toBe(before);
  });

  it("a ZIP that doesn't rebuild identically, or a failed final verification, is rolled back", () => {
    const w = world({ installersSigned: true });
    const before = JSON.stringify(w.releaseFiles());
    w.control.dropOnZip = "README.txt";
    const result = run(w);
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toContain("missing after repacking: OpenMind Studio/README.txt");
    expect(JSON.stringify(w.releaseFiles())).toBe(before);

    const v = world({ installersSigned: true });
    const vBefore = JSON.stringify(v.releaseFiles());
    v.control.verify = "metadata/SHA256SUMS.txt: 1 file doesn't match";
    expect(run(v).ok).toBe(false);
    expect(JSON.stringify(v.releaseFiles())).toBe(vBefore);
  });

  it("without the updater key nothing changes (a .sig would go stale)", () => {
    const w = world({ installersSigned: true });
    const before = JSON.stringify(w.releaseFiles());
    w.control.updater = "No key password";
    const result = run(w);
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("stale .sig");
    expect(JSON.stringify(w.releaseFiles())).toBe(before);
  });

  it("an installer signed by another certificate or changed after signing is refused", () => {
    const w = world({ installersSigned: true });
    w.sigs.set(`windows/x64/OpenMind-Studio_${V}_windows_x64.msi`, { status: "Valid", signerThumbprint: OTHER });
    w.sigs.set(`windows/x86/OpenMind-Studio_${V}_windows_x86_setup.exe`, { status: "HashMismatch", signerThumbprint: THUMB });
    const result = run(w);
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toContain("another certificate");
    expect(result.blockers.join(" ")).toContain("HashMismatch");
    expect(w.calls.sign).toEqual([]);
  });

  it("a test run without the updater key removes the stale .sig files and rewrites the checksums", () => {
    const w = world({ installersSigned: true });
    w.control.updater = "No key password";
    const result = run(w, { skipUpdater: true, arches: ["x64"] });
    expect(result.ok).toBe(true);
    const zip = `windows/x64/OpenMind-Studio_${V}_windows_x64_portable.zip`;
    expect(w.files.has(`${zip}.sig`)).toBe(false);
    expect(w.files.has("metadata/latest.json")).toBe(false);
    expect(w.calls.checksums).toBe(1);
    expect(w.calls.resign).toBe(0);
    expect(w.log.join("\n")).toContain("NOT RELEASABLE");
  });
});
