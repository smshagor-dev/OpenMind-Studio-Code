// usage: node scripts/tauri-signed.mjs build --bundles nsis,msi [...]
// Runs the Tauri CLI with the updater signing key in its environment (scripts/updaterKey.mjs), so the installers get
// their `.sig` update signatures. The key and password never reach this process's output.
import { spawnSync } from "node:child_process";

import { updaterSigningEnv } from "./updaterKey.mjs";

let signing;
try {
  signing = updaterSigningEnv();
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
const result = spawnSync("pnpm", ["tauri", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, ...signing },
});
process.exit(result.status ?? 1);
