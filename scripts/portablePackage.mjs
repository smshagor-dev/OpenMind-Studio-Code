// Pure helpers for `package-portable.mjs`: names and the text of the README that ships in the zip.
// Kept free of I/O so they are unit-tested (src/services/packaging.test.ts).

/** The executable's name in the package (Cargo's own binary is `openmind-studio`). */
export const PACKAGE_EXE = "OpenMindStudio.exe";

/** The folder inside the zip, and what the user unzips. */
export const PACKAGE_FOLDER = "OpenMind Studio";

/** `OpenMindStudio-0.1.0-portable-win-x64.zip` */
export function zipName(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`"${version}" is not a version number.`);
  }
  return `OpenMindStudio-${version}-portable-win-x64.zip`;
}

/**
 * Where `tauri build` puts the app for a profile: Tauri names the binary after `mainBinaryName`
 * (`OpenMindStudio.exe`); a plain `cargo build` leaves Cargo's own `openmind-studio.exe`.
 */
export function builtExe(targetDir, profile, cargoName = false) {
  if (profile !== "release" && profile !== "debug") {
    throw new Error(`Unknown profile "${profile}".`);
  }
  const name = cargoName ? "openmind-studio.exe" : PACKAGE_EXE;
  return `${targetDir.replace(/[\\/]+$/, "")}/${profile}/${name}`;
}

export function readmeText(version) {
  return [
    `OpenMind Studio ${version} — portable edition`,
    "",
    "Run OpenMindStudio.exe. There is nothing to install and no administrator rights are needed.",
    "",
    "Everything the app keeps lives in this folder, next to the executable — never in AppData,",
    "the Registry or Program Files, and it never changes your PATH:",
    "",
    "  data\\        the SQLite database (openmind-studio.db)",
    "  settings\\    settings.json and keybindings.json (edit them by hand or from the Settings page)",
    "  runtimes\\    portable Node.js, Python, Git, PHP, MariaDB ... you install from the Runtime Manager",
    "  cache\\       downloads and package caches",
    "  logs\\        the app's and the language servers' logs",
    "",
    "Move or copy the whole folder anywhere (a USB drive, a path with spaces) and it keeps working.",
    "To remove the app, close it and delete the folder.",
    "",
    "Workspace settings are stored inside each project you open, in .openmind\\settings.json.",
    "",
  ].join("\r\n");
}
