import { vi } from "vitest";

import type {
  ExtensionContributions,
  ExtensionsIpc,
  ExtensionsSnapshot,
  InstalledExtension,
} from "../services/extensionsIpc";

export function emptyContributions(): ExtensionContributions {
  return {
    commands: [],
    menus: {},
    unsupportedMenus: [],
    keybindings: [],
    configuration: [],
    unsupportedProperties: [],
    configurationDefaults: {},
    languages: [],
    grammars: [],
    snippets: [],
    themes: [],
    iconThemes: [],
    debuggers: [],
    problemMatchers: [],
    views: { containers: [], elsewhere: 0, otherContainers: 0 },
    aiProviders: [],
    unsupportedAiProviders: [],
    unsupported: {},
  };
}

/** An installed extension for tests; override what a test cares about. */
export function testExtension(
  overrides: Partial<InstalledExtension> & { contributes?: Partial<ExtensionContributions> } = {},
): InstalledExtension {
  const { contributes, ...rest } = overrides;
  const name = rest.manifest?.name ?? "sample-command";
  const publisher = rest.manifest?.publisher ?? "openmind-samples";
  return {
    id: `${publisher}.${name}`,
    folder: `${publisher}.${name}-1.0.0`,
    path: `C:/app/extensions/installed/${publisher}.${name}-1.0.0`,
    enabled: true,
    manifest: {
      name,
      displayName: "Sample Command",
      description: "Contributes one command.",
      version: "1.0.0",
      publisher,
      enginesVscode: "^1.85.0",
      categories: [],
      icon: null,
      main: "./extension.js",
      browser: null,
      extensionDependencies: [],
      extensionPack: [],
      contributes: { ...emptyContributions(), ...contributes },
      requestedPermissions: [],
    },
    points: [],
    runtimeRequirement: "Node.js runtime is required for extension host.",
    warnings: [],
    activationEvents: [],
    permissions: { requested: [], inferred: ["commands"], accepted: ["commands"], highRisk: [] },
    ...rest,
  };
}

export function emptyExtensionsSnapshot(
  overrides: Partial<ExtensionsSnapshot> = {},
): ExtensionsSnapshot {
  return {
    extensions: [],
    broken: [],
    activity: {},
    host: { state: "stopped", pid: null, node: null, error: null },
    node: { portable: true, system: null, allowSystem: false },
    root: "C:/app/extensions",
    logsDir: "C:/app/extensions/logs",
    hostLog: "C:/app/extensions/logs/extension-host.log",
    ...overrides,
  };
}

export function createFakeExtensionsIpc(): ExtensionsIpc {
  return {
    extList: vi.fn().mockResolvedValue(emptyExtensionsSnapshot()),
    extInspectVsix: vi.fn().mockResolvedValue(testExtension()),
    extInstall: vi.fn().mockResolvedValue(testExtension()),
    extSetEnabled: vi.fn().mockResolvedValue(testExtension()),
    extUninstall: vi.fn().mockResolvedValue(undefined),
    extGrantPermission: vi.fn().mockResolvedValue(testExtension()),
    extWebviewReadResource: vi.fn().mockResolvedValue("data:image/png;base64,AAAA"),
    extReadFile: vi.fn().mockResolvedValue("{}"),
    extReadIcon: vi.fn().mockResolvedValue("data:image/svg+xml;base64,PHN2Zy8+"),
    extHostLog: vi.fn().mockResolvedValue(""),
    extHostStart: vi
      .fn()
      .mockResolvedValue({ state: "running", pid: 1, node: "OpenMind portable Node.js", error: null }),
    extHostStop: vi.fn().mockResolvedValue(undefined),
    extHostRequest: vi.fn().mockResolvedValue(null),
    extHostNotify: vi.fn().mockResolvedValue(undefined),
    extHostRespond: vi.fn().mockResolvedValue(undefined),
    extActivateFor: vi.fn().mockResolvedValue([]),
    extPickVsix: vi.fn().mockResolvedValue(null),
    onExtChanged: vi.fn().mockResolvedValue(() => undefined),
    onExtHostRequest: vi.fn().mockResolvedValue(() => undefined),
    onExtHostNotification: vi.fn().mockResolvedValue(() => undefined),
    onExtHostState: vi.fn().mockResolvedValue(() => undefined),
  };
}
