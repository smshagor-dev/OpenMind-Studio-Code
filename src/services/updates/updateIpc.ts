import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** `updates::Phase`. */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "failed";

/** `updates::policy::SelfUpdate`: how this copy takes updates. */
export type UpdateMode = { kind: "installer" } | { kind: "portable" } | { kind: "managed"; reason: string };

/** `updates::policy::Failure`. */
export type UpdateFailureKind = "network" | "feed" | "signature" | "install" | "other";

/** `updates::Activity`: what Restart to Update would interrupt, across every window. */
export interface UpdateActivity {
  unsaved: number;
  terminals: number;
  busyTerminals: number;
  runs: number;
}

/** `updates::UpdateInfo`. */
export interface UpdateInfo {
  current: string;
  available: boolean;
  version: string | null;
  notes: string | null;
  date: string | null;
  install: "nsis" | "msi" | "portable";
  mode: UpdateMode;
  phase: UpdatePhase;
  mandatory: boolean;
  ready: boolean;
  installOnExit: boolean;
  automatic: boolean;
  downloaded: number;
  total: number | null;
  failure: { kind: UpdateFailureKind; message: string } | null;
  lastChecked: string | null;
  releasesPage: string;
  activity: UpdateActivity;
}

export interface UpdateProgress {
  version: string;
  downloaded: number;
  total: number | null;
}

export interface UpdateIpc {
  status: () => Promise<UpdateInfo>;
  check: () => Promise<UpdateInfo>;
  download: () => Promise<UpdateInfo>;
  installNow: (confirmed: boolean) => Promise<void>;
  setInstallOnExit: (enabled: boolean) => Promise<void>;
  reportUnsaved: (count: number) => Promise<void>;
  onState: (listener: (info: UpdateInfo) => void) => Promise<() => void>;
  onProgress: (listener: (progress: UpdateProgress) => void) => Promise<() => void>;
}

export const tauriUpdateIpc: UpdateIpc = {
  status: () => invoke<UpdateInfo>("update_status"),
  check: () => invoke<UpdateInfo>("update_check"),
  download: () => invoke<UpdateInfo>("update_download"),
  installNow: (confirmed) => invoke("update_install_now", { confirmed }),
  setInstallOnExit: (enabled) => invoke("update_install_on_exit", { enabled }),
  reportUnsaved: (count) => invoke("update_report_unsaved", { count }),
  onState: (listener) =>
    listen<UpdateInfo>("update:state", (event) => {
      listener(event.payload);
    }),
  onProgress: (listener) =>
    listen<UpdateProgress>("update:progress", (event) => {
      listener(event.payload);
    }),
};
