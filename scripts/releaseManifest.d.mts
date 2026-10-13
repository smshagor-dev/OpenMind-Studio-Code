import type { Artifact } from "./releaseTools.mjs";

export function releaseFiles(dir: string): Artifact[];
export function writeManifest(dir: string): Artifact[];
export function verifyManifest(dir: string): string[];
