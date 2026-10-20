import { invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/commands/pascalabc.rs (serde camelCase).

/** Which compiler Run Code uses for Pascal files (the `pascal.compiler` setting). */
export type PascalCompilerId = "fpc" | "pascalabc";

export interface PascalStatus {
  /** The compiler for the asking window's folder. */
  compiler: PascalCompilerId;
  /** PascalABC.NET can run here at all (Windows). */
  platformSupported: boolean;
  dotnetFramework: { version: string | null; satisfied: boolean };
  /** The PascalABC.NET version shipped with this copy of OpenMind, if any. */
  bundledVersion: string | null;
  /** Why the shipped bundle can't be used. */
  bundleProblem: string | null;
}

export const pascalIpc = {
  status: () => invoke<PascalStatus>("pascal_status"),
};

/** The setting's value as a compiler id: anything but `pascalabc` is Free Pascal (the backend reads it the same way). */
export function compilerOf(value: string): PascalCompilerId {
  return value.trim() === "pascalabc" ? "pascalabc" : "fpc";
}

export function compilerName(id: PascalCompilerId): string {
  return id === "pascalabc" ? "PascalABC.NET" : "Free Pascal";
}

/** One line of the PascalABC.NET card: an i18n key, its values, and whether it is a problem. */
export interface SetupLine {
  key: string;
  values?: Record<string, string>;
  problem: boolean;
}

/** What the PascalABC.NET card says about what it needs besides its own files. */
export function pascalAbcSetup(status: PascalStatus): SetupLine[] {
  if (!status.platformSupported) return [{ key: "pascal.setup.unsupportedPlatform", problem: true }];
  const lines: SetupLine[] = [];
  const dotnet = status.dotnetFramework;
  if (dotnet.satisfied) {
    lines.push({ key: "pascal.setup.dotnetOk", values: { version: dotnet.version ?? "" }, problem: false });
  } else if (dotnet.version !== null) {
    lines.push({ key: "pascal.setup.dotnetOld", values: { version: dotnet.version }, problem: true });
  } else {
    lines.push({ key: "pascal.setup.dotnetMissing", problem: true });
  }
  if (status.bundledVersion !== null) {
    lines.push({ key: "pascal.setup.bundled", values: { version: status.bundledVersion }, problem: false });
  } else if (status.bundleProblem !== null) {
    lines.push({ key: "pascal.setup.bundleProblem", values: { reason: status.bundleProblem }, problem: true });
  } else {
    lines.push({ key: "pascal.setup.download", problem: false });
  }
  lines.push({
    key: status.compiler === "pascalabc" ? "pascal.setup.usedByRunCode" : "pascal.setup.notChosen",
    problem: false,
  });
  return lines;
}
