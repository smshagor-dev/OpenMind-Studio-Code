import { invoke } from "@tauri-apps/api/core";

/** A VS Code user profile found on this computer (the backend lists them; the page never sends a path). */
export interface VsCodeSource {
  edition: string;
  profile: string;
  label: string;
}

/** What a VS Code profile would bring, already translated to OpenMind's settings and commands. */
export interface VsCodePreview {
  settings: { id: string; value: unknown }[];
  keybindings: { key: string; command: string }[];
  extensions: string[];
  snippets: string[];
  skipped: string[];
  warnings: string[];
}

export interface VsCodeImportResult {
  settingsImported: number;
  shortcutsImported: number;
  settingsBackup: string | null;
  shortcutsBackup: string | null;
  skipped: string[];
  warnings: string[];
}

export interface VsCodeImportIpc {
  sources: () => Promise<VsCodeSource[]>;
  preview: (edition: string, profile: string) => Promise<VsCodePreview>;
  apply: (
    edition: string,
    profile: string,
    importSettings: boolean,
    importShortcuts: boolean,
  ) => Promise<VsCodeImportResult>;
  importSnippets: (edition: string, profile: string) => Promise<number>;
  importProfile: (edition: string, profile: string) => Promise<unknown>;
  importExtension: (edition: string, folder: string) => Promise<{ id: string }>;
}

export const tauriVsCodeImportIpc: VsCodeImportIpc = {
  sources: () => invoke<VsCodeSource[]>("vscode_import_sources"),
  preview: (edition, profile) => invoke<VsCodePreview>("vscode_import_preview", { edition, profile }),
  apply: (edition, profile, importSettings, importShortcuts) =>
    invoke<VsCodeImportResult>("vscode_import_apply", { edition, profile, importSettings, importShortcuts }),
  importSnippets: (edition, profile) => invoke<number>("vscode_import_snippets", { edition, profile }),
  importProfile: (edition, profile) => invoke("vscode_import_profile", { edition, profile }),
  importExtension: (edition, folder) => invoke<{ id: string }>("vscode_import_extension", { edition, folder }),
};
