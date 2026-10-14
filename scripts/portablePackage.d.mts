export const PACKAGE_EXE: string;
export const PACKAGE_FOLDER: string;
export function zipName(version: string): string;
export function builtExe(targetDir: string, profile: string, cargoName?: boolean): string;
export function readmeText(version: string, arch: "x64" | "x86"): string;

export const MAX_BUNDLED_VERSIONS: number;
/** Problems that stop a `tools-bundle` from being packaged (empty = fine). */
export function validateToolchainManifest(
  manifest: unknown,
  exists: (relativePath: string) => boolean,
  platform?: string,
): string[];
