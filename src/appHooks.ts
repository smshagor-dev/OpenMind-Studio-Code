import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import type { ToastMessage } from "./components/ErrorToast";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { container } from "./services/container";
import { StartupTimings } from "./services/startupTimings";
import { startDeployment } from "./services/deployment";
import { startUpdates } from "./services/updates";
import type { PinnedFolderEntry, RecentFileInfo, WorkspaceInfo } from "./services/ipc";

const TOAST_LIFETIME_MS = 6000;

/** The extension host and its questions live in the main window; other editor windows only list extensions. */
function isMainWindow(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return false;
  }
}

/** Restores persisted state (theme, layout, editor options, window zoom, workspace, session) once, then reports ready. */
export function useAppStartup(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // An object (not a `let`) so the async closure sees the cleanup's write.
    const lifecycle = { cancelled: false };
    let stopWindowTracking: (() => void) | null = null;
    const timings = new StartupTimings();
    void (async () => {
      // Settings and shortcuts first: everything below reads them.
      await container.startSettings();
      timings.mark("settings");
      await Promise.all([
        container.theme.initialize(),
        container.layout.initialize(),
        container.editor.initialize(),
        container.terminal.initialize(),
        container.panel.initialize(),
        container.associations.initialize(),
        container.previews.initialize(),
        container.runConfigs.initialize(),
        container.welcome.initialize(true),
        container.secondarySideBar.initialize(),
        // Listens for runtime changes made in the PHP Server window too.
        container.runtime.initialize(),
      ]);
      timings.mark("workbench");
      const windowTracking = container.window.initialize().then(
        (stop) => {
          if (lifecycle.cancelled) stop();
          else stopWindowTracking = stop;
          return true;
        },
        (error: unknown) => {
          container.events.emit("appError", {
            message: `Window controls unavailable: ${String(error)}`,
          });
          return false;
        },
      );
      await container.workspace.restoreActiveWorkspace();
      timings.mark("workspace");
      // Before the session: files it reopens must already know the languages extensions contribute.
      await container.startExtensions(isMainWindow());
      timings.mark("extensions");
      await container.startAi();
      timings.mark("ai");
      await container.startLanguage();
      timings.mark("language");
      await container.startFormatting();
      timings.mark("formatting");
      await container.workspace.restoreSession();
      // A window opened for a tab dragged out of another window opens that file.
      await container.editorWindows.openPending();
      // `OpenMindStudio.exe <folder|file ...>` (File Explorer, the `openmind` command): after the session, so it wins.
      if (isMainWindow()) {
        await container.editorWindows.openLaunch();
        await container.editorWindows.restoreWindows();
      }
      timings.mark("session");
      // The editor is usable now: what follows (services that only mirror state or wait for a click) must not keep
      // the window blank.
      // No editable workbench is shown before the native recovery/close listener is ready.
      if (!(await windowTracking)) return;
      if (!lifecycle.cancelled) setReady(true);
      // A UI that came up in another language than English offers English once per language (not awaited: a dialog).
      if (isMainWindow() && !lifecycle.cancelled) void container.offerEnglish();
      const usable = timings.elapsed();
      await Promise.all([
        container.runCode.initialize(),
        container.runArguments.load(),
        container.php.initialize(),
        // The main window mirrors the database services' output and ports too.
        container.mariaDb.initialize(),
        container.phpMyAdmin.initialize(),
        container.composer.initialize(),
        container.fileSync.initialize(),
        container.startLanguageTools(),
        container.startDebugTools(),
        container.git.initialize(),
        // Follows the backend's update schedule (nothing is checked or downloaded from here).
        startUpdates(),
        // Help > Network Deployment and the "offer on the local network" setting (nothing is searched or sent).
        startDeployment(),
        // Reads the open folder's manifests (nothing runs, nothing installs).
        container.dependencies.initialize(),
        // A joined room's shared tree and remote documents follow `collab:remote` (nothing is fetched here).
        container.collab.start().then(
          () => undefined,
          () => undefined,
        ),
      ]);
      await container.sourceControl.initialize();
      timings.mark("background");
      // Only now may extensions with "*" / onStartupFinished run: the window is up and the session restored.
      if (isMainWindow()) container.finishExtensionsStartup();
      if (isMainWindow()) {
        container.reportStartup(timings.phases(), usable);
      }
    })();
    return () => {
      lifecycle.cancelled = true;
      stopWindowTracking?.();
    };
  }, []);

  return ready;
}

/** Routes app-owned keybindings (see `DEFAULT_KEYBINDINGS`) to commands. */
export function useGlobalKeybindings(): void {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const command = container.keybindings.resolve(event);
      if (command) {
        event.preventDefault();
        container.run(command);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
}

/** Collects `appError` events as auto-dismissing toasts. */
export function useToasts(): [ToastMessage[], (id: number) => void] {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    const add = (message: string, kind?: "info") => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, kind }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, TOAST_LIFETIME_MS);
    };
    const offError = container.events.on("appError", ({ message }) => {
      add(message);
    });
    const offNotice = container.events.on("appNotice", ({ message }) => {
      add(message, "info");
    });
    return () => {
      offError();
      offNotice();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);
  return [toasts, dismiss];
}

export interface Recents {
  files: RecentFileInfo[];
  folders: WorkspaceInfo[];
  pinnedFolders: PinnedFolderEntry[];
}

/**
 * Recent files/folders/pinned folders for the Welcome page and File > Open
 * Recent; `refresh` re-reads them, and pinning/unpinning a folder anywhere in
 * the app (e.g. the explorer's header toggle) triggers a re-read too.
 */
export function useRecents(): [Recents, () => void] {
  const [recents, setRecents] = useState<Recents>({ files: [], folders: [], pinnedFolders: [] });
  const refresh = useCallback(() => {
    void Promise.all([
      container.workspace.loadRecentFiles(),
      container.workspace.loadRecentFolders(),
      container.workspace.loadPinnedFolders(),
    ]).then(([files, folders, pinnedFolders]) => {
      setRecents({ files, folders, pinnedFolders });
    });
  }, []);
  useEffect(() => container.events.on("pinnedFoldersChanged", refresh), [refresh]);
  return [recents, refresh];
}

/**
 * Re-renders after every executed command and every editor status change, so
 * UI reflecting command enablement (command center, menus' next open) stays current.
 */
export function useCommandStateRefresh(): void {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => container.commands.onDidExecute(bump), []);
  useEffect(() => container.editor.subscribe(bump), []);
}

/** `true` while the Runtime Manager dialog should be shown (opened by the `runtime.manage` command). */
export function useRuntimeManagerDialog(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      container.events.on("showRuntimeManager", () => {
        setOpen(true);
      }),
    [],
  );
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  return [open, close];
}

/** `true` while the Language Tools dialog should be shown (opened by the `lsp.manage` command). */
export function useLanguageToolsDialog(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      container.events.on("showLanguageTools", () => {
        setOpen(true);
      }),
    [],
  );
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  return [open, close];
}

/** `true` while the Configure Run Command dialog should be shown (opened by `run.configure`). */
export function useRunConfigurationDialog(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      container.events.on("showRunConfiguration", () => {
        setOpen(true);
      }),
    [],
  );
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  return [open, close];
}

/** `true` while the About dialog should be shown (opened by the `help.about` command). */
export function useAboutDialog(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      container.events.on("showAbout", () => {
        setOpen(true);
      }),
    [],
  );
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  return [open, close];
}

/** The external stores the workbench shell renders from. */
export function useWorkbenchState() {
  const workspaceState = useSyncExternalStore(
    (listener) => container.workspace.subscribe(listener),
    () => container.workspace.getState(),
  );
  const activeWorkspace = useSyncExternalStore(
    (listener) => container.workspace.subscribeWorkspace(listener),
    () => container.workspace.getActiveWorkspace(),
  );
  const themeKind = useSyncExternalStore(
    (listener) => container.theme.subscribe(listener),
    () => container.theme.getTheme(),
  );
  const layout = useSyncExternalStore(
    (listener) => container.layout.subscribe(listener),
    () => container.layout.getState(),
  );
  return { workspaceState, activeWorkspace, themeKind, layout };
}


