import { invoke } from "@tauri-apps/api/core";

/** `openmind_core::DataScope`: one profile for this copy, or one per computer. */
export type DataScopeMode = "personal" | "perMachine";

/** Where this computer's identity came from (`openmind_core::machine_identity::IdentitySource`). */
export type IdentitySource = "system" | "persisted" | "generated" | "ephemeral";

export interface ExistingDatabase {
  path: string;
  bytes: number;
}

export interface MachineProfileSummary {
  profileId: string;
  hasDatabase: boolean;
  lastUsedAt: string | null;
}

/** The backend's `data_scope::ScopeStatus`. It never contains the computer's raw identifier. */
export interface DataScopeStatus {
  /** `null` while the scope hasn't been chosen (the setup window). */
  mode: DataScopeMode | null;
  recommended: DataScopeMode;
  profileId: string;
  identitySource: IdentitySource;
  appFolder: string;
  sharedDatabase: ExistingDatabase | null;
  machineDatabase: ExistingDatabase | null;
  profiles: MachineProfileSummary[];
  unreadable: string | null;
  singleComputer: boolean;
  /** How this copy was installed (`openmind_core::install::InstallLayout`). */
  layout: InstallLayout;
  /** Set by the installer (per-machine or network installation): shown, never changeable here. */
  managed: boolean;
  /** This computer's local folder for this installation (managed layouts keep their data there). */
  localFolder: string | null;
  /** The program runs from a temporary folder (a ZIP opened without extracting it): nothing chosen would last. */
  temporaryFolder: boolean;
}

/** `openmind_core::install::InstallLayout`. */
export type InstallLayout = "portable" | "perUser" | "perMachine" | "network";

/** The backend's `data_scope::migrate::ScheduledChange`: what the next start will do. */
export interface MigrationOutcome {
  /** The database the next start opens. */
  database: string;
  /** It exists already and is used as it is. */
  keptExisting: boolean;
  /** The profile in use is copied there (and checked) at the next start. */
  willImport: boolean;
}

export interface DataScopeApi {
  status: () => Promise<DataScopeStatus>;
  /** Saves the choice; with `useExisting` the profile in use is copied (never moved) at the next start when the new
   * scope has none. */
  apply: (mode: DataScopeMode, useExisting: boolean) => Promise<MigrationOutcome>;
  restart: () => Promise<void>;
  exit: () => Promise<void>;
}

/** The setup window (before any database is open). */
export const tauriSetupApi: DataScopeApi = {
  status: () => invoke<DataScopeStatus>("data_scope_status"),
  apply: (mode, useExisting) =>
    invoke<MigrationOutcome>("data_scope_setup_apply", { mode, useExisting }),
  restart: () => invoke("data_scope_restart"),
  exit: () => invoke("data_scope_exit"),
};

/** The workbench's Data Scope dialog. */
export const tauriWorkbenchApi: DataScopeApi = {
  ...tauriSetupApi,
  apply: (mode, useExisting) => invoke<MigrationOutcome>("data_scope_change", { mode, useExisting }),
};

/** Must match `data_scope::SETUP_WINDOW_LABEL`. */
export const DATA_SCOPE_SETUP_WINDOW_LABEL = "data-scope-setup";

/** The profile whose data the other scope could start from: the one in use now, or (during setup) the old one. */
export function sourceProfile(status: DataScopeStatus, target: DataScopeMode): ExistingDatabase | null {
  return target === "perMachine" ? status.sharedDatabase : status.machineDatabase;
}

/** The profile the target scope would use as it is (nothing copied). */
export function targetProfile(status: DataScopeStatus, target: DataScopeMode): ExistingDatabase | null {
  return target === "perMachine" ? status.machineDatabase : status.sharedDatabase;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
