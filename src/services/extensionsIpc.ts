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

/** A tree (drawn by the app) or webview (not supported) view inside an activity bar container. */
export interface ExtensionViewContribution {
  id: string;
  name: string;
  kind: "tree" | "webview";
  /** `viewsWelcome` entries shown while the view is empty, each with its `when` clause. */
  welcome: { contents: string; when: string | null }[];
}

/** One activity bar icon an extension contributes. */
export interface ExtensionViewContainer {
  id: string;
  title: string;
  /** A file inside the extension, or a product icon such as `$(list-tree)`. */
  icon: string | null;
  views: ExtensionViewContribution[];
}

export interface ExtensionViews {
  containers: ExtensionViewContainer[];
  elsewhere: number;
  otherContainers: number;
}

/** An AI provider an extension offers (declarative: the app's own client talks to it; the extension never sees a key). */
export interface ExtensionAiProviderContribution {
  id: string;
  name: string;
  /** `claude`, `openai-compatible`, `gemini` or `local`. */
  type: string;
  capabilities: string[];
  defaultModel: string | null;
  models: string[];
  baseUrl: string | null;
  description: string | null;
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
  /** Task types the extension's task provider serves (Milestone 18). */
  taskDefinitions: { type: string; required: string[] }[];
  productIconThemes: { id: string; label: string; path: string }[];
  debuggers: { kind: string; label: string | null }[];
  problemMatchers: string[];
  views: ExtensionViews;
  aiProviders: ExtensionAiProviderContribution[];
  unsupportedAiProviders: string[];
  unsupported: Record<string, number>;
}

export type PermissionName =
  | "workspaceRead"
  | "workspaceWrite"
  | "commands"
  | "settings"
  | "languages"
  | "themes"
  | "snippets"
  | "network"
  | "processExecution"
  | "terminal"
  | "filesystemOutsideWorkspace";

/** What an extension asked for, what its contributions imply, and what the host lets it use. */
export interface PermissionSet {
  requested: PermissionName[];
  inferred: PermissionName[];
  accepted: PermissionName[];
  highRisk: PermissionName[];
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
  requestedPermissions: PermissionName[];
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
  permissions: PermissionSet;
  /** False when it asks for a newer VS Code engine than OpenMind's API subset (it isn't started then). */
  engineSupported: boolean;
  /** The user chose to run it although its engine isn't supported. */
  runAnyway: boolean;
}

export interface BrokenExtension {
  folder: string;
  enabled: boolean;
  error: string;
}

export interface ExtensionActivity {
  active: boolean;
  lastError: string | null;
  /** How many times it was activated since the app started. */
  activationCount: number;
  lastActivation: string | null;
  /** VS Code APIs it called that OpenMind Studio doesn't support (Milestone 18). */
  unsupportedApis?: string[];
}

export type ExtensionHostState =
  "stopped" | "starting" | "running" | "crashed" | "restarting" | "unavailable";

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
export interface VsCodeExtensionSource {
  id: string;
  label: string;
}

export interface ExtensionsIpc {
  extDetectVscode: () => Promise<VsCodeExtensionSource[]>;
  extImportVscode: (sourceId: string) => Promise<InstalledExtension>;
  extInspectVsix: (path: string) => Promise<InstalledExtension>;
  extInstall: (path: string, replace: boolean) => Promise<InstalledExtension>;
  extSetEnabled: (id: string, enabled: boolean) => Promise<InstalledExtension>;
  extUninstall: (id: string) => Promise<void>;
  /** The user's own grant of a permission the extension doesn't request (outside-workspace files). */
  extGrantPermission: (id: string, permission: PermissionName) => Promise<InstalledExtension>;
  extSetRunAnyway: (id: string, allow: boolean) => Promise<InstalledExtension>;
  /** A local file for an extension's webview as a `data:` URL; the backend re-checks roots, type and size. */
  extWebviewReadResource: (id: string, path: string, roots: string[]) => Promise<string>;
  extReadFile: (id: string, path: string) => Promise<string>;
  /** Snippet files imported from VS Code (Settings > Import from VS Code), per language. */
  extImportedSnippets: () => Promise<{ language: string; text: string }[]>;
  /** An `.svg`/`.png` inside the extension as a `data:` URL. */
  extReadIcon: (id: string, path: string) => Promise<string>;
  /** How many secrets an extension keeps (`context.secrets`); never their values. */
  extSecretsCount: (id: string) => Promise<number>;
  /** Forgets every secret of an extension. */
  extSecretsClear: (id: string) => Promise<void>;
  extHostLog: () => Promise<string>;
  extHostStart: (initial: unknown) => Promise<ExtensionHostStatus>;
  extHostStop: () => Promise<void>;
  extHostRequest: (method: string, params: unknown) => Promise<unknown>;
  extHostNotify: (method: string, params: unknown) => Promise<void>;
  extHostRespond: (id: unknown, result: unknown, error: string | null) => Promise<void>;
  extActivateFor: (trigger: ActivationTrigger) => Promise<ActivationResult[]>;
  extPickVsix: () => Promise<string | null>;
  onExtHostRequest: (handler: (request: HostRequest) => void) => Promise<() => void>;
  onExtHostNotification: (handler: (notification: HostNotification) => void) => Promise<() => void>;
  onExtHostState: (handler: (status: ExtensionHostStatus) => void) => Promise<() => void>;
}

export const tauriExtensionsIpc: ExtensionsIpc = {
  extDetectVscode: () => invoke<VsCodeExtensionSource[]>("ext_detect_vscode"),
  extImportVscode: (sourceId) => invoke<InstalledExtension>("ext_import_vscode", { sourceId }),
  extInspectVsix: (path) => invoke<InstalledExtension>("ext_inspect_vsix", { path }),
  extInstall: (path, replace) => invoke<InstalledExtension>("ext_install", { path, replace }),
  extSetEnabled: (id, enabled) => invoke<InstalledExtension>("ext_set_enabled", { id, enabled }),
  extUninstall: (id) => invoke("ext_uninstall", { id }),
  extWebviewReadResource: (id, path, roots) =>
    invoke<string>("ext_webview_read_resource", { id, path, roots }),
  extSetRunAnyway: (id, allow) => invoke<InstalledExtension>("ext_set_run_anyway", { id, allow }),
  extGrantPermission: (id, permission) =>
    invoke<InstalledExtension>("ext_grant_permission", { id, permission }),
  extReadFile: (id, path) => invoke<string>("ext_read_file", { id, path }),
  extImportedSnippets: () => invoke<{ language: string; text: string }[]>("vscode_imported_snippets"),
  extReadIcon: (id, path) => invoke<string>("ext_read_icon", { id, path }),
  extSecretsCount: (id) => invoke<number>("ext_secrets_count", { id }),
  extSecretsClear: (id) => invoke("ext_secrets_clear", { id }),
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
