export interface VersionSource {
  file: string;
  version: string | null;
}

export function versionSources(files: {
  packageJson: string;
  tauriConf: string;
  cargoToml: string;
  appCargoToml: string;
}): VersionSource[];
