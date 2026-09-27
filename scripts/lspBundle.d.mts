export const BUNDLE_FORMAT: string;
export const BUNDLE_VERSION: number;
export const BUNDLE_PLATFORM: string;

export interface NodeEntry {
  version: string;
  path: string;
  sha256: string;
  size: number;
  license: string;
}

export interface PackEntry {
  package: string;
  revision: string;
  contents: string;
  file: string;
  sha256: string;
  size: number;
  license: string;
}

export interface BundleManifest {
  format: string;
  version: number;
  platform: string;
  createdAt?: string;
  node: NodeEntry | null;
  packs: PackEntry[];
}

/** One registry package, as `bundle_tool packages` prints it. */
export interface ExpectedPackage {
  id: string;
  revision: string;
  contents: string;
  native?: boolean;
  redistributable: boolean;
}

export interface NoticeItem {
  name: string;
  version: string;
  license: string;
}

export function packFileName(id: string, revision: string): string;
export function safeRelative(path: string): boolean;
export function strippedName(name: string, strip: number, skip?: string[]): string | null;
export function bundleManifest(input: {
  createdAt: string;
  node: NodeEntry;
  packs: PackEntry[];
}): BundleManifest & { node: NodeEntry };
export function validateLspBundle(
  manifest: BundleManifest,
  expected: ExpectedPackage[],
  fileSize: (relativePath: string) => number | null,
): string[];
export function noticesText(sections: { title: string; items: NoticeItem[] }[]): string;
export function licenseOf(pkg: {
  license?: string | { type?: string };
  licenses?: ({ type?: string } | string)[];
}): string;
