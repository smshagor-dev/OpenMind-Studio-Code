// The release key that signs update files (tauri updater, minisign). The private key stays outside the repository:
//   OPENMIND_UPDATER_KEY                 path of the key (default: %USERPROFILE%\.openmind-keys\openmind-updater.key)
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD   its password; when unset it is read from openmind-updater.password.dpapi next to
//                                        the key (Windows DPAPI, readable only by the Windows account that wrote it).
// The key and the password only ever go into the environment of the `tauri` process that signs; nothing is printed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function updaterKeyPaths(env) {
  const key = env.OPENMIND_UPDATER_KEY || join(env.USERPROFILE || "", ".openmind-keys", "openmind-updater.key");
  return { key, passwordFile: join(dirname(key), "openmind-updater.password.dpapi") };
}

function dpapiPassword(file) {
  const script =
    "$s = Get-Content -LiteralPath $env:OM_PASSWORD_FILE | ConvertTo-SecureString; " +
    "[Console]::Out.Write([Net.NetworkCredential]::new('', $s).Password)";
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, OM_PASSWORD_FILE: file },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The environment `tauri build` / `tauri signer sign` needs to sign update files. Throws with what is missing. */
export function updaterSigningEnv(env = process.env) {
  const { key, passwordFile } = updaterKeyPaths(env);
  if (!existsSync(key)) {
    throw new Error(
      `The updater signing key was not found at ${key}. Set OPENMIND_UPDATER_KEY or create it (docs/updates.md).`,
    );
  }
  let password = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  if (password === undefined) {
    if (!existsSync(passwordFile)) {
      throw new Error(`No key password: set TAURI_SIGNING_PRIVATE_KEY_PASSWORD or provide ${passwordFile}.`);
    }
    password = dpapiPassword(passwordFile);
  }
  return {
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(key, "utf8").trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  };
}
