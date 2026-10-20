export const BUNDLE_FORMAT: string;
export const ARCHIVE: string;
export const LICENSE_FILES: string[];
export const NOTICE: string;

export interface PinnedArchive {
  version: string;
  url: string;
  sha256: string;
  size: number;
}
export interface ArchiveFacts {
  sha256: string;
  size: number;
}
export interface BundleRecord {
  format: string;
  version: number;
  compilerVersion: string;
  file: string;
  sha256: string;
  size: number;
  source: string;
  licenses: string[];
}

export function pinnedArtifact(manifest: unknown): PinnedArchive;
export function archiveProblem(pinned: PinnedArchive, actual: ArchiveFacts): string | null;
export function bundleRecord(pinned: PinnedArchive): BundleRecord;
export function validateBundle(record: unknown, pinned: PinnedArchive, files: string[]): string[];
