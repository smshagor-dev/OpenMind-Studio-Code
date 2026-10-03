import { invoke } from "@tauri-apps/api/core";

// Mirrors openmind_toolchains (serde camelCase). Listing only looks at files; Verify runs a program only on a click.

export type ToolCategory =
  | "runtime"
  | "packageManager"
  | "languageServer"
  | "formatter"
  | "linter"
  | "debugger"
  | "vcs"
  | "databaseTool"
  | "helperTool"
  | "sdk";

/** A bundled tool's overall state. */
export type ToolState = "active" | "missing" | "broken" | "external";
export type VersionState = "active" | "bundled" | "broken";

export interface ToolVersion {
  version: string;
  /** The program's absolute path. */
  path: string;
  status: VersionState;
  latest: boolean;
  sizeBytes: number | null;
  license: string | null;
  licenseUrl: string | null;
  verifyArgs: string[] | null;
  /** Installed from Language Tools (`tools/installed.json`) rather than shipped with the app. */
  installed: boolean;
  /** Variables a process needs for it: [name, absolute path]. */
  env: [string, string][];
}

export interface ToolEntry {
  id: string;
  name: string;
  category: ToolCategory;
  /** One short sentence for the card. */
  summary: string;
  /** The long explanation, for the details dialog only. */
  details: string;
  usedBy: string[];
  command: string;
  hint: string;
  status: ToolState;
  activeVersion: string | null;
  /** Newest first. */
  versions: ToolVersion[];
  maxVersions: number;
  ignoredVersions: number;
  path: string | null;
}

export interface ToolchainPacks {
  toolsDir: string;
  platform: string;
  manifestFound: boolean;
  manifestError: string | null;
  warnings: string[];
  tools: ToolEntry[];
}

export interface VerifyResult {
  ok: boolean;
  message: string;
  executed: boolean;
  output: string | null;
}

export interface ToolchainIpc {
  toolchainsSetActive: (id: string, version: string) => Promise<ToolchainPacks>;
  toolchainsVerify: (id: string, version: string | null) => Promise<VerifyResult>;
  /** Downloads and installs a tool package into `tools/` (Language Tools > Install). */
  toolchainsInstall: (id: string) => Promise<ToolchainPacks>;
  /** Removes a tool installed from Language Tools. */
  toolchainsRemove: (id: string) => Promise<ToolchainPacks>;
}

export const tauriToolchainIpc: ToolchainIpc = {
  toolchainsSetActive: (id, version) =>
    invoke<ToolchainPacks>("toolchains_set_active", { id, version }),
  toolchainsVerify: (id, version) => invoke<VerifyResult>("toolchains_verify", { id, version }),
  toolchainsInstall: (id) => invoke<ToolchainPacks>("toolchains_install", { id }),
  toolchainsRemove: (id) => invoke<ToolchainPacks>("toolchains_remove", { id }),
};
