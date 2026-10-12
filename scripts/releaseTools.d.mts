export const SIGNING_VARIABLES: string[];

export interface SigningConfig {
  mode: "unsigned" | "signed" | "test-signed" | "misconfigured";
  message: string;
  certPath?: string;
  password?: string;
  timestampUrl?: string | null;
}

export function readSigningConfig(env: Record<string, string | undefined>): SigningConfig;
export function publicSigningInfo(config: SigningConfig): {
  mode: string;
  message: string;
  timestamp: string | null;
};
export function signtoolArgs(config: SigningConfig, file: string): string[];
export function redact(text: unknown, secrets: (string | undefined)[]): string;
export interface SignatureInfo {
  status: string;
  signer: string | null;
  timestamped: boolean;
  timestamper: string | null;
}
export function signatureVerdict(
  info: SignatureInfo | null,
  mode: "signed" | "test-signed" | "external",
  options?: { timestampWaived?: boolean },
): string | null;
export function releaseName(kind: "setup" | "msi" | "portable" | "deb" | "appimage" | "linux-portable", version: string, arch?: string): string;
export function formatSize(bytes: number): string;

export interface Artifact {
  name: string;
  size: number;
  sha256: string;
  kind: string;
}

export function reportText(input: {
  version: string;
  arch: string;
  buildType: string;
  date: string;
  artifacts: Artifact[];
  notes?: string[];
}): string;
export function checksumsText(artifacts: Artifact[]): string;
export function checkWixSource(wxs: string): string[];
export function checkInstallerConfig(tauri: Record<string, unknown>, licenseText: string): string[];
export function checkInstallerHooks(nsh: string): string[];
export function unconditionalEnvironment(wxs: string): string[];
export const RELEASE_REPO: string;
export const UPDATE_ENDPOINT: string;
export function releaseDownloadUrl(version: string, name: string): string;
export interface SignedFile {
  kind: "setup" | "msi" | "portable";
  arch: "x64" | "x86";
  name: string;
  signature: string;
}
export interface FeedEntry {
  signature: string;
  url: string;
}
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export function latestJson(input: {
  version: string;
  notes: string;
  pubDate: string;
  minimumVersion?: string | null;
  files: SignedFile[];
}): {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, FeedEntry>;
  openmind: { channel: "stable"; minimumVersion?: string; portable: Record<string, FeedEntry> };
};
export function signedVersion(sig: string): string | null;
export function checkUpdaterConfig(tauri: Record<string, unknown>): string[];
