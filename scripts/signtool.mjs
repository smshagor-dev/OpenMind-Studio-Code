// signtool.exe (Windows SDK) for the release scripts: find it, sign one file with the configuration from
// releaseTools.readSigningConfig, and tell whether a file already carries an Authenticode signature.
// The certificate password (pfx mode) goes only into signtool's arguments and is redacted from any error text.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { redact, signtoolArgs } from "./releaseTools.mjs";

export function findSigntool() {
  const kits = process.env["ProgramFiles(x86)"]
    ? join(process.env["ProgramFiles(x86)"], "Windows Kits", "10", "bin")
    : null;
  if (!kits || !existsSync(kits)) return null;
  const versions = readdirSync(kits)
    .filter((v) => /^\d/.test(v))
    .sort()
    .reverse();
  for (const version of versions) {
    const candidate = join(kits, version, "x64", "signtool.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Signs `file` in place. Returns `null` on success, otherwise the (redacted) reason. */
export function signFile(config, file) {
  const tool = findSigntool();
  if (tool === null) return "signtool.exe (Windows SDK) was not found";
  const result = spawnSync(tool, signtoolArgs(config, file), { encoding: "utf8" });
  if (result.status === 0) return null;
  return redact(result.stderr || result.stdout || "signtool error", [config.password]);
}

/** True when the file has an Authenticode signature (trusted or not). */
export function hasSignature(file) {
  const script =
    "$s = Get-AuthenticodeSignature -LiteralPath $env:OM_SIGNED_FILE; " +
    "[Console]::Out.Write([string]($null -ne $s.SignerCertificate))";
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, OM_SIGNED_FILE: file },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim() === "True";
}
