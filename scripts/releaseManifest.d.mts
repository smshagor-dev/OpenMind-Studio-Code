import type { Artifact } from "./releaseTools.mjs";

export type ManifestFile = Artifact & { arch: string; path: string };
export const manifestPath: (dir: string) => string;
export function releaseFiles(dir: string): ManifestFile[];
export function misplacedFiles(dir: string): string[];
export function writeManifest(dir: string): ManifestFile[];
export function verifyManifest(dir: string): string[];
