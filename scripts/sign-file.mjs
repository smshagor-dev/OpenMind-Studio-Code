// usage: node scripts/sign-file.mjs <file>
// Tauri's `bundle.windows.signCommand`: called for every Windows binary `tauri build` produces (OpenMindStudio.exe,
// the NSIS installer and uninstaller, the MSI) *before* the updater `.sig` files are made, so those stay valid.
// Signing is configured through the environment (docs/release.md); with nothing configured the file is left
// unsigned (development builds), a half-made configuration stops the build.
import { readSigningConfig } from "./releaseTools.mjs";
import { signFile } from "./signtool.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/sign-file.mjs <file>");
  process.exit(2);
}
const config = readSigningConfig(process.env);
if (config.mode === "unsigned") process.exit(0);
if (config.mode === "misconfigured") {
  console.error(config.message);
  process.exit(1);
}
const problem = signFile(config, file);
if (problem !== null) {
  console.error(`Signing ${file} failed: ${problem}`);
  process.exit(1);
}
console.log(`Signed ${file}`);
