import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

/** How far the app supports a contribution point (mirrors the backend's `Support`). */
export type ContributionSupport = "supported" | "metadata" | "unsupported";

export interface ContributionPoint {
  point: string;
  count: number;
  support: ContributionSupport;
  note: string | null;
}

export interface ExtensionCommandContribution {
  command: string;
  title: string;
  category: string | null;
}

export interface ExtensionMenuContribution {
  command: string;
  when: string | null;
  group: string | null;
}

export interface ExtensionKeybindingContribution {
  command: string;
  /** Already in the app's spelling (`Ctrl+Alt+H`). */
  key: string;
  when: string | null;
}

export type ConfigurationKind =
  | { type: "boolean" }
  | { type: "integer"; minimum: number; maximum: number }
  | { type: "string"; maxLength: number }
  | { type: "enum"; options: string[] };

export interface ExtensionConfigurationProperty {
  key: string;
  kind: ConfigurationKind;
  default: unknown;
  description: string;
  title: string | null;
}

export interface ExtensionLanguageContribution {
  id: string;
  extensions: string[];
  filenames: string[];
  aliases: string[];
}

export interface ExtensionSnippetContribution {
  language: string;
  path: string;
}

export interface ExtensionThemeContribution {
  label: string;
  /** `vs`, `vs-dark`, `hc-black` or `hc-light`. */
  uiTheme: string;
  path: string;
}

export interface ExtensionContributions {
  commands: ExtensionCommandContribution[];
  menus: Record<string, ExtensionMenuContribution[]>;
  unsupportedMenus: string[];
  keybindings: ExtensionKeybindingContribution[];
  configuration: ExtensionConfigurationProperty[];
  unsupportedProperties: string[];
  configurationDefaults: Record<string, unknown>;
  languages: ExtensionLanguageContribution[];
  grammars: { language: string | null; scopeName: string | null; path: string | null }[];
  snippets: ExtensionSnippetContribution[];
  themes: ExtensionThemeContribution[];
  iconThemes: { id: string; label: string; path: string }[];
  debuggers: { kind: string; label: string | null }[];
  problemMatchers: string[];
  unsupported: Record<string, number>;
}

export interface ExtensionManifest {
  name: string;
  displayName: string | null;
  description: string | null;
  version: string;
  publisher: string;
  enginesVscode: string | null;
  categories: string[];
  icon: string | null;
  main: string | null;
  browser: string | null;
  extensionDependencies: string[];
  extensionPack: string[];
  contributes: ExtensionContributions;
}

export interface InstalledExtension {
  id: string;
  folder: string;
  path: string;
  enabled: boolean;
  manifest: ExtensionManifest;
  points: ContributionPoint[];
  /** Set when it has code: what the extension host needs. */
  runtimeRequirement: string | null;
  warnings: string[];
  activationEvents: string[];
}

export interface BrokenExtension {
  folder: string;
  enabled: boolean;
  error: string;
}

export interface ExtensionActivity {
  active: boolean;
  lastError: string | null;
}

export type ExtensionHostState = "stopped" | "running" | "crashed" | "unavailable";

export interface ExtensionHostStatus {
  state: ExtensionHostState;
  pid: number | null;
  node: string | null;
  error: string | null;
}

export interface ExtensionNodeInfo {
  portable: boolean;
  /** A Node.js found on this computer; never used unless the setting allows it. */
  system: string | null;
  allowSystem: boolean;
}

export interface ExtensionsSnapshot {
  extensions: InstalledExtension[];
  broken: BrokenExtension[];
  activity: Record<string, ExtensionActivity>;
  host: ExtensionHostStatus;
  node: ExtensionNodeInfo;
  root: string;
  logsDir: string;
  hostLog: string;
}

export type ActivationTrigger =
  | { kind: "startup" }
  | { kind: "command"; command: string }
  | { kind: "language"; language: string }
  | { kind: "view"; view: string }
  | { kind: "workspace"; root: string };

export interface ActivationResult {
  id: string;
  ok: boolean;
  error: string | null;
}

/** A question the extension host asks the window (`ext:host-request`). */
export interface HostRequest {
  id: unknown;
  method: string;
  params: unknown;
}

export interface HostNotification {
  method: string;
  params: unknown;
}

/** The extension slice of the IPC client. */
export interface ExtensionsIpc {
  extList: () => Promise<ExtensionsSnapshot>;
  extInspectVsix: (path: string) => Promise<InstalledExtension>;
  extInstall: (path: string, replace: boolean) => Promise<InstalledExtension>;
  extSetEnabled: (id: string, enabled: boolean) => Promise<InstalledExtension>;
  extUninstall: (id: string) => Promise<void>;
  extReadFile: (id: string, path: string) => Promise<string>;
  extHostLog: () => Promise<string>;
  extHostStart: (initial: unknown) => Promise<ExtensionHostStatus>;
  extHostStop: () => Promise<void>;
  extHostRequest: (method: string, params: unknown) => Promise<unknown>;
  extHostNotify: (method: string, params: unknown) => Promise<void>;
  extHostRespond: (id: unknown, result: unknown, error: string | null) => Promise<void>;
  extActivateFor: (trigger: ActivationTrigger) => Promise<ActivationResult[]>;
  extPickVsix: () => Promise<string | null>;
  onExtChanged: (handler: () => void) => Promise<() => void>;
  onExtHostRequest: (handler: (request: HostRequest) => void) => Promise<() => void>;
  onExtHostNotification: (handler: (notification: HostNotification) => void) => Promise<() => void>;
  onExtHostState: (handler: (status: ExtensionHostStatus) => void) => Promise<() => void>;
}

export const tauriExtensionsIpc: ExtensionsIpc = {
  extList: () => invoke<ExtensionsSnapshot>("ext_list"),
  extInspectVsix: (path) => invoke<InstalledExtension>("ext_inspect_vsix", { path }),
  extInstall: (path, replace) => invoke<InstalledExtension>("ext_install", { path, replace }),
  extSetEnabled: (id, enabled) => invoke<InstalledExtension>("ext_set_enabled", { id, enabled }),
  extUninstall: (id) => invoke("ext_uninstall", { id }),
  extReadFile: (id, path) => invoke<string>("ext_read_file", { id, path }),
  extHostLog: () => invoke<string>("ext_host_log"),
  extHostStart: (initial) => invoke<ExtensionHostStatus>("ext_host_start", { initial }),
  extHostStop: () => invoke("ext_host_stop"),
  extHostRequest: (method, params) => invoke<unknown>("ext_host_request", { method, params }),
  extHostNotify: (method, params) => invoke("ext_host_notify", { method, params }),
  extHostRespond: (id, result, error) => invoke("ext_host_respond", { id, result, error }),
  extActivateFor: (trigger) => invoke<ActivationResult[]>("ext_activate_for", { trigger }),
  async extPickVsix() {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "VS Code extension (.vsix)", extensions: ["vsix"] }],
    });
    return typeof selected === "string" ? selected : null;
  },
  onExtChanged: (handler) =>
    listen("ext:changed", () => {
      handler();
    }),
  onExtHostRequest: (handler) =>
    listen<HostRequest>("ext:host-request", (event) => {
      handler(event.payload);
    }),
  onExtHostNotification: (handler) =>
    listen<HostNotification>("ext:host-notification", (event) => {
      handler(event.payload);
    }),
  onExtHostState: (handler) =>
    listen<ExtensionHostStatus>("ext:host-state", (event) => {
      handler(event.payload);
    }),
};
