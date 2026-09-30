export const BUNDLE_FORMAT: string;
export const BUNDLE_VERSION: number;
export const WHEELS_ZIP: string;
export const REQUIREMENTS: string;
export const ADDON_FILE: string;

export interface WheelId {
  name: string;
  version: string;
}
export interface BuiltWheel extends WheelId {
  sha256: string;
}
export interface BundleConfig {
  python: string;
  runtimeVersion: string;
  platform: string;
  stdlib: string[];
  packages: { name: string; import: string }[];
  addon?: string;
}

export function normalizeName(name: string): string;
export function parseWheelName(file: string): WheelId | null;
export function parseLock(text: string): WheelId[];
export function compareWithLock(lock: WheelId[], wheels: WheelId[]): string[];
export function requirementsText(wheels: BuiltWheel[]): string;
export function bundleManifest(input: {
  config: BundleConfig;
  wheels: BuiltWheel[];
  zip: { sha256: string; size: number };
  addon: { sha256: string; url: string } | null;
  createdAt: string;
}): Record<string, unknown>;
export function validatePythonBundle(
  manifest: Record<string, unknown> | null,
  config: BundleConfig,
  fileSha: (file: string) => string | null,
): string[];
