// Pure helpers of scripts/build-info.mjs (tested in src/services/buildInfo.test.ts).

/**
 * The release version as each file declares it: package.json, tauri.conf.json, the workspace Cargo.toml
 * (`[workspace.package] version`) and the app's Cargo.toml (its own `version`, or `version.workspace = true`).
 * `version` is null when the file doesn't say.
 */
export function versionSources({ packageJson, tauriConf, cargoToml, appCargoToml }) {
  const workspace = /^\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(cargoToml)?.[1] ?? null;
  const app = /^version\.workspace\s*=\s*true\s*$/m.test(appCargoToml)
    ? workspace
    : (/^\[package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(appCargoToml)?.[1] ?? null);
  return [
    { file: "package.json", version: JSON.parse(packageJson).version ?? null },
    { file: "src-tauri/tauri.conf.json", version: JSON.parse(tauriConf).version ?? null },
    { file: "Cargo.toml", version: workspace },
    { file: "src-tauri/Cargo.toml", version: app },
  ];
}
