// Windows Authenticode signing with signtool.exe (Windows SDK), for the release scripts: find SignTool, check the
// certificate, sign one file by certificate thumbprint, and verify the result with Windows itself.
//
// Secrets: SignTool never gets a password. A certificate in the Windows store (or on a hardware token / cloud HSM that
// shows up there) is used by its thumbprint. A PFX file is imported into the current user's store first — not
// exportable, its password handed to PowerShell through an environment variable, never on a command line — used by
// thumbprint, and removed again afterwards if this run imported it. The rules live in authenticodeTools.mjs (tested).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

import {
  certificateVerdict,
  classifySigntoolFailure,
  findSigntoolIn,
  signtoolSignArgs,
  SIGNING_DESCRIPTION,
} from "./authenticodeTools.mjs";
import { redact, signatureVerdict } from "./releaseTools.mjs";

function powershell(script, env = {}) {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const hostArch = process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "x86" : "x64";

/** signtool.exe's path, or null (`findSigntoolProblem` says why). */
export function findSigntool() {
  return findSigntoolIn(process.env, { exists: existsSync, list: (dir) => readdirSync(dir) }, hostArch).path ?? null;
}

export function findSigntoolProblem() {
  return findSigntoolIn(process.env, { exists: existsSync, list: (dir) => readdirSync(dir) }, hostArch).problem ?? null;
}

/**
 * What Windows knows about the certificate with this thumbprint in CurrentUser\My (then LocalMachine\My):
 * `{ found, thumbprint, store, subject, notBefore, notAfter, hasPrivateKey, ekus, keyAlgorithm, chainTrusted,
 * chainStatus }`. The chain is built for the Code Signing usage with an online revocation check (15 s).
 */
export function certificateInfo(thumbprint) {
  const script = `
$t = $env:OM_CERT_THUMBPRINT
$store = 'user'; $c = Get-Item -LiteralPath "Cert:\\CurrentUser\\My\\$t" -ErrorAction SilentlyContinue
if (-not $c) { $store = 'machine'; $c = Get-Item -LiteralPath "Cert:\\LocalMachine\\My\\$t" -ErrorAction SilentlyContinue }
if (-not $c) { [Console]::Out.Write((@{ found = $false; thumbprint = $t } | ConvertTo-Json -Compress)); exit 0 }
$chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
$chain.ChainPolicy.RevocationMode = 'Online'
$chain.ChainPolicy.RevocationFlag = 'ExcludeRoot'
$chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(15)
$null = $chain.ChainPolicy.ApplicationPolicy.Add((New-Object System.Security.Cryptography.Oid '1.3.6.1.5.5.7.3.3'))
$ok = $chain.Build($c)
$status = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() } | Sort-Object -Unique)
$other = @($status | Where-Object { $_ -notmatch 'Revocation' })
[Console]::Out.Write((@{
  found = $true; thumbprint = $c.Thumbprint; store = $store; subject = $c.Subject
  notBefore = $c.NotBefore.ToUniversalTime().ToString('o'); notAfter = $c.NotAfter.ToUniversalTime().ToString('o')
  hasPrivateKey = $c.HasPrivateKey; ekus = @($c.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId })
  keyAlgorithm = $c.PublicKey.Oid.Value; chainTrusted = ($ok -or $other.Count -eq 0); chainStatus = $status
} | ConvertTo-Json -Compress))`;
  return JSON.parse(powershell(script, { OM_CERT_THUMBPRINT: thumbprint }));
}

/**
 * Runs `fn({ thumbprint, store })` with the configured certificate available in the Windows store. For a PFX it is
 * imported for the duration (not exportable) unless the store already holds it, and removed afterwards if it was
 * imported here. Returns what `fn` returns.
 */
export function withCertificate(config, fn) {
  if (config.thumbprint) return fn({ thumbprint: config.thumbprint });
  if (!config.certPath || !existsSync(config.certPath)) {
    throw new Error("The certificate file (SIGNING_CERT_PATH) doesn't exist.");
  }
  const env = { OM_PFX_PATH: config.certPath, OM_PFX_PASSWORD: config.password };
  let imported;
  try {
    imported = JSON.parse(
      powershell(
        `$pw = ConvertTo-SecureString -String $env:OM_PFX_PASSWORD -AsPlainText -Force
$data = Get-PfxData -FilePath $env:OM_PFX_PATH -Password $pw
$t = $data.EndEntityCertificates[0].Thumbprint
$already = Test-Path -LiteralPath "Cert:\\CurrentUser\\My\\$t"
if (-not $already) { $null = Import-PfxCertificate -FilePath $env:OM_PFX_PATH -CertStoreLocation Cert:\\CurrentUser\\My -Password $pw }
[Console]::Out.Write((@{ thumbprint = $t; imported = -not $already } | ConvertTo-Json -Compress))`,
        env,
      ),
    );
  } catch (error) {
    const text = redact(String(error?.stderr ?? error?.message ?? error), [config.password]);
    throw new Error(
      /password/i.test(text)
        ? "The PFX file couldn't be opened: the certificate password is wrong."
        : `The PFX file couldn't be opened: ${text.split(/\r?\n/)[0]}`,
    );
  }
  try {
    return fn({ thumbprint: imported.thumbprint });
  } finally {
    if (imported.imported) {
      try {
        powershell(`Remove-Item -LiteralPath "Cert:\\CurrentUser\\My\\$env:OM_CERT_THUMBPRINT" -DeleteKey`, {
          OM_CERT_THUMBPRINT: imported.thumbprint,
        });
      } catch {
        console.error(
          `The temporarily imported certificate ${imported.thumbprint} could not be removed from CurrentUser\\My: remove it with certmgr.msc.`,
        );
      }
    }
  }
}

/** The certificate checks before anything is signed: `{ problems, warnings, info }` (no secrets in any of it). */
export function checkCertificate(config, thumbprint) {
  const info = certificateInfo(thumbprint);
  return { ...certificateVerdict(info, config.mode), info };
}

/**
 * What Windows says about a file's Authenticode signature: `{ status, signer, signerThumbprint, timestamped, timestamper }`
 * (`status` is Get-AuthenticodeSignature's: Valid, NotTrusted, HashMismatch, NotSigned, UnknownError ...).
 */
export function inspectSignature(file) {
  const script =
    "$s = Get-AuthenticodeSignature -LiteralPath $env:OM_SIGNED_FILE; " +
    "[Console]::Out.Write((@{ status = [string]$s.Status; " +
    "signer = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }; " +
    "signerThumbprint = if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { $null }; " +
    "timestamped = $null -ne $s.TimeStamperCertificate; " +
    "timestamper = if ($s.TimeStamperCertificate) { $s.TimeStamperCertificate.Subject } else { $null } } | ConvertTo-Json -Compress))";
  return JSON.parse(powershell(script, { OM_SIGNED_FILE: file }));
}

/** True when the file has an Authenticode signature (trusted or not). */
export function hasSignature(file) {
  return inspectSignature(file).signerThumbprint !== null;
}

/**
 * Signs `file` in place and verifies it: the certificate is checked first (dates, Code Signing usage, private key,
 * RSA, trust for a release), SignTool signs by thumbprint with SHA-256 and the RFC 3161 timestamp, then Windows must
 * report the signature valid (intact for a test certificate), timestamped and made by this very certificate.
 * Returns `null` on success, otherwise the (redacted) reason. Warnings go to stderr.
 */
export function signFile(config, file, { description = SIGNING_DESCRIPTION } = {}) {
  const tool = findSigntool();
  if (tool === null) return findSigntoolProblem();
  if (!existsSync(file)) return `${file} doesn't exist`;
  try {
    return withCertificate(config, ({ thumbprint }) => {
      const check = checkCertificate(config, thumbprint);
      for (const warning of check.warnings) console.error(`warning: ${warning}`);
      if (check.problems.length > 0) return check.problems.join(" ");
      const args = signtoolSignArgs(
        { thumbprint, store: check.info.store, timestampUrl: config.timestampUrl, description },
        file,
      );
      const result = spawnSync(tool, args, { encoding: "utf8" });
      if (result.status !== 0) {
        return classifySigntoolFailure(redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, [config.password]));
      }
      const signature = inspectSignature(file);
      const problem = signatureVerdict(signature, config.mode, { timestampWaived: !config.timestampUrl });
      if (problem !== null) return `the signature didn't verify: ${problem}`;
      if ((signature.signerThumbprint ?? "").toUpperCase() !== thumbprint) {
        return `the file carries a signature by another certificate (${signature.signerThumbprint})`;
      }
      return null;
    });
  } catch (error) {
    return redact(String(error instanceof Error ? error.message : error), [config.password]);
  }
}
