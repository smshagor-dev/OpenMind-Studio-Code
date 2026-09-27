import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** The backend's `startup_error::StartupFailure`. */
export interface StartupFailure {
  failure: { kind: string; version?: number | null };
  category: string;
  title: string;
  explanation: string;
  nextSteps: string[];
  dbPath: string;
  dataDir: string;
  errorChain: string[];
  details: string;
  canBackUp: boolean;
}

/** What the start-up error page can do. It never touches the database except through `backUp`, after a confirmation. */
export interface StartupErrorApi {
  info: () => Promise<StartupFailure>;
  openDataFolder: () => Promise<void>;
  copy: (text: string) => Promise<void>;
  /** Moves the database files into a backup folder and answers that folder. */
  backUp: () => Promise<string>;
  restart: () => Promise<void>;
  exit: () => Promise<void>;
}

export const tauriStartupErrorApi: StartupErrorApi = {
  info: () => invoke<StartupFailure>("startup_error_info"),
  openDataFolder: () => invoke("startup_error_open_data_folder"),
  copy: (text) => writeText(text),
  backUp: () => invoke<string>("startup_error_back_up"),
  restart: () => invoke("startup_error_restart"),
  exit: () => invoke("startup_error_exit"),
};

/** The window label the backend gives the error window (`startup_error::STARTUP_ERROR_WINDOW_LABEL`). */
export const STARTUP_ERROR_WINDOW_LABEL = "startup-error";

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
