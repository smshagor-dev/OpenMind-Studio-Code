export const CODE_SIGNING_EKU: string;
export const RSA_OID: string;
export const SIGNING_DESCRIPTION: string;
export const OUR_BINARIES: string[];
export const EXPIRY_WARNING_DAYS: number;

export function findSigntoolIn(
  env: Record<string, string | undefined>,
  fs: { exists(path: string): boolean; list(dir: string): string[] },
  hostArch?: "x64" | "x86" | "arm64",
): { path?: string; problem?: string };

export interface CertificateInfo {
  found: boolean;
  thumbprint?: string;
  store?: "user" | "machine";
  subject?: string;
  notBefore?: string;
  notAfter?: string;
  hasPrivateKey?: boolean;
  ekus?: string[];
  keyAlgorithm?: string;
  chainTrusted?: boolean;
  chainStatus?: string[];
}

export function certificateVerdict(
  info: CertificateInfo | null,
  mode: string,
  now?: Date,
): { problems: string[]; warnings: string[] };

export function signtoolSignArgs(
  options: { thumbprint?: string; store?: "user" | "machine"; timestampUrl?: string | null; description?: string },
  file: string,
): string[];

export function classifySigntoolFailure(output: string): string;

export interface SignatureState {
  status: string;
  signerThumbprint: string | null;
}

export function planArtifact(
  kind: "setup" | "msi" | "portable",
  state: { exists: boolean; signature: SignatureState | null; innerSignature: SignatureState | null },
  options: { thumbprint: string; signInstallersOuter?: boolean },
): { action: "keep" | "sign" | "repack" | "refuse"; reason: string };

export function compareTrees(
  before: Record<string, string>,
  after: Record<string, string>,
  signed: string[],
): string[];

export function describePlan(steps: { action: string; path: string; reason: string }[]): string[];
