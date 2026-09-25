export const PACKAGE_EXE: string;
export const PACKAGE_FOLDER: string;
export function zipName(version: string): string;
export function builtExe(targetDir: string, profile: string, cargoName?: boolean): string;
export function readmeText(version: string): string;
