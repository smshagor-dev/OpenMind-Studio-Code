import { vi } from "vitest";

import type { IpcClient } from "../services/ipc";

/**
 * A fully-stubbed `IpcClient` for tests, so each test file only needs to
 * override the handful of methods it actually cares about instead of
 * re-declaring every method on the interface.
 */
export function createFakeIpc(overrides: Partial<IpcClient> = {}): IpcClient {
  return {
    openDocumentDialog: vi.fn().mockResolvedValue(null),
    saveDocumentDialog: vi.fn().mockResolvedValue(null),
    openFolderDialog: vi.fn().mockResolvedValue(null),
    documentOpen: vi.fn(),
    documentSave: vi.fn().mockResolvedValue(undefined),
    recentFilesList: vi.fn().mockResolvedValue([]),
    recentFilesClear: vi.fn().mockResolvedValue(undefined),
    sessionLoad: vi.fn().mockResolvedValue({ openPaths: [], activePath: null }),
    sessionSave: vi.fn().mockResolvedValue(undefined),
    themeGet: vi.fn().mockResolvedValue("dark"),
    themeSet: vi.fn().mockResolvedValue(undefined),
    workspaceOpenFolder: vi.fn(),
    workspaceCloseFolder: vi.fn().mockResolvedValue(undefined),
    workspaceRecentFolders: vi.fn().mockResolvedValue([]),
    workspaceActiveFolder: vi.fn().mockResolvedValue(null),
    explorerStateLoad: vi.fn().mockResolvedValue({ expandedPaths: [], selectedPath: null }),
    explorerStateSave: vi.fn().mockResolvedValue(undefined),
    pinFolder: vi.fn().mockResolvedValue(undefined),
    unpinFolder: vi.fn().mockResolvedValue(undefined),
    listPinnedFolders: vi.fn().mockResolvedValue([]),
    fsReadDir: vi.fn().mockResolvedValue([]),
    fsMetadata: vi.fn(),
    fsIsBinary: vi.fn().mockResolvedValue(false),
    fsCreateFile: vi.fn(),
    fsCreateFolder: vi.fn(),
    fsRename: vi.fn(),
    fsDelete: vi.fn().mockResolvedValue(undefined),
    fsMove: vi.fn(),
    fsCopy: vi.fn(),
    fsDuplicate: vi.fn(),
    settingsGet: vi.fn().mockResolvedValue(null),
    settingsSet: vi.fn().mockResolvedValue(undefined),
    terminalListShells: vi.fn().mockResolvedValue([]),
    terminalCreate: vi.fn(),
    terminalWrite: vi.fn().mockResolvedValue(undefined),
    terminalResize: vi.fn().mockResolvedValue(undefined),
    terminalClose: vi.fn().mockResolvedValue(undefined),
    onTerminalOutput: vi.fn().mockResolvedValue(() => undefined),
    onTerminalExit: vi.fn().mockResolvedValue(() => undefined),
    clipboardWriteText: vi.fn().mockResolvedValue(undefined),
    clipboardReadText: vi.fn().mockResolvedValue(""),
    appInfo: vi.fn().mockResolvedValue({ version: "0.0.0-test", tauriVersion: "2.0.0" }),
    ...overrides,
  };
}
