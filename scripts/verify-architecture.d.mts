export function peArch(bytes: Buffer): "x64" | "x86" | null;
export function elfArch(bytes: Buffer): "x64" | "x86" | null;
export function tarEntries(tar: Buffer): { name: string; type: string; data: Buffer }[];
export function arEntries(ar: Buffer): { name: string; data: Buffer }[];
export function zipEntry(zip: Buffer, wanted: (name: string) => boolean): { name: string; data: Buffer } | null;
export function inspectFile(
  path: string,
  name: string,
): { name: string; expected: string | null; found: string | null; ok: boolean; note: string };
export function machoArches(bytes: Buffer): ("x64" | "x86" | "arm64")[];
