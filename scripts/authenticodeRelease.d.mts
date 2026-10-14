import type { SignatureState } from "./authenticodeTools.mjs";

export const PACKAGE_FOLDER: string;

export function windowsFiles(version: string, arch: string): { kind: "setup" | "msi" | "portable"; path: string }[];

export interface SigningCertificate {
  thumbprint: string;
  problems: string[];
  warnings: string[];
}

export interface AuthenticodeEffects {
  log(line: string): void;
  signtoolProblem(): string | null;
  withSigningCertificate<T>(fn: (cert: SigningCertificate) => T): T;
  exists(path: string): boolean;
  signature(path: string): SignatureState & { timestamped?: boolean };
  sign(path: string, cert: SigningCertificate): string | null;
  extract(zip: string, dir: string): void;
  createZip(base: string, folder: string, zip: string): void;
  hashTree(dir: string): Record<string, string>;
  sha256(path: string): string;
  tempDir(prefix: string): string;
  copyFile(from: string, to: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  removeTree(path: string): void;
  stamp(): string;
  updaterProblem(): string | null;
  resignUpdater(): string | null;
  writeChecksums(): string | null;
  verifyRelease(options: { skipUpdater: boolean }): string | null;
}

export interface AuthenticodeResult {
  ok: boolean;
  blockers: string[];
  steps: { kind: string; path: string; action: string; reason: string }[];
  changed: { path: string; before: string; after: string }[];
  backup: string | null;
}

export function runAuthenticodeRelease(
  options: {
    version: string;
    arches: string[];
    dryRun?: boolean;
    signInstallersOuter?: boolean;
    skipUpdater?: boolean;
  },
  effects: AuthenticodeEffects,
): AuthenticodeResult;
