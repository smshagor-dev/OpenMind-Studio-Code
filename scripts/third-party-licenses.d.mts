export interface LicenseText {
  file: string;
  text: string;
}
export interface Component {
  name: string;
  license: string;
  texts: LicenseText[];
}
export function licenseFilesIn(dir: string): LicenseText[];
export function groupByText(components: Component[]): {
  groups: { text: string; users: string[] }[];
  missing: Component[];
};
export function noticesText(
  sections: { title: string; intro?: string; components: Component[] }[],
  appendix?: { title: string; text: string }[],
): { text: string; missing: number };
export function shippedPackageIds(meta: {
  workspace_members: string[];
  resolve: { nodes: { id: string; deps?: { pkg: string; dep_kinds?: { kind: string | null }[] }[] }[] };
}): Set<string>;
export function fallbackIds(expression: string, available: { has(id: string): boolean }): string[];
export function withFallbackTexts(components: Component[], spdx: Map<string, string>): Component[];
