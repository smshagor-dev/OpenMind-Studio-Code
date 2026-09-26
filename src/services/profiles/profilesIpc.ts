import { invoke } from "@tauri-apps/api/core";

// Mirrors openmind_settings::profiles (serde camelCase).

export interface ProfileSummary {
  id: string;
  name: string;
  active: boolean;
  settingCount: number;
  /** Seconds since 1970. */
  updatedAt: number;
}

export interface ProfileList {
  profiles: ProfileSummary[];
  active: string;
  /** Profile files that were skipped because they are damaged or unknown. */
  problems: string[];
  /** The only settings a profile carries. */
  covers: string[];
}

export interface ProfilesIpc {
  profilesList: () => Promise<ProfileList>;
  profileCreate: (name: string, fromCurrent: boolean) => Promise<ProfileList>;
  profileSwitch: (id: string) => Promise<ProfileList>;
  profileRename: (id: string, name: string) => Promise<ProfileList>;
  profileDuplicate: (id: string, name: string) => Promise<ProfileList>;
  profileDelete: (id: string) => Promise<ProfileList>;
  profileExport: (id: string) => Promise<string>;
  profileImport: (text: string) => Promise<ProfileList>;
}

export const tauriProfilesIpc: ProfilesIpc = {
  profilesList: () => invoke<ProfileList>("profiles_list"),
  profileCreate: (name, fromCurrent) =>
    invoke<ProfileList>("profile_create", { name, fromCurrent }),
  profileSwitch: (id) => invoke<ProfileList>("profile_switch", { id }),
  profileRename: (id, name) => invoke<ProfileList>("profile_rename", { id, name }),
  profileDuplicate: (id, name) => invoke<ProfileList>("profile_duplicate", { id, name }),
  profileDelete: (id) => invoke<ProfileList>("profile_delete", { id }),
  profileExport: (id) => invoke<string>("profile_export", { id }),
  profileImport: (text) => invoke<ProfileList>("profile_import", { text }),
};
