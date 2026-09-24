import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import type { ToastMessage } from "./components/ErrorToast";
import { container } from "./services/container";
import type { PinnedFolderEntry, RecentFileInfo, WorkspaceInfo } from "./services/ipc";

const TOAST_LIFETIME_MS = 6000;

/** Restores persisted state (theme, layout, editor options, window zoom, workspace, session) once, then reports ready. */
export function useAppStartup(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // An object (not a `let`) so the async closure sees the cleanup's write.
    const lifecycle = { cancelled: false };
    let stopWindowTracking: (() => void) | null = null;
    void (async () => {
      await Promise.all([
        container.theme.initialize(),
        container.layout.initialize(),
        container.editor.initialize(),
        container.terminal.initialize(),
        container.panel.initialize(),
        container.associations.initialize(),
        container.previews.initialize(),
        container.runConfigs.initialize(),
        // Listens for runtime changes made in the PHP Server window too.
        container.runtime.initialize(),
      ]);
      container.window.initialize().then(
        (stop) => {
          if (lifecycle.cancelled) stop();
          else stopWindowTracking = stop;
        },
        (error: unknown) => {
          container.events.emit("appError", {
            message: `Window controls unavailable: ${String(error)}`,
          });
        },
      );
      await container.workspace.restoreActiveWorkspace();
      await container.workspace.restoreSession();
      await container.runCode.initialize();
      await container.php.initialize();
      // The main window mirrors the database services' output and ports too.
      await Promise.all([
        container.mariaDb.initialize(),
        container.phpMyAdmin.initialize(),
        container.composer.initialize(),
      ]);
      if (!lifecycle.cancelled) setReady(true);
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

  useEffect(
    () =>
      container.events.on("appError", ({ message }) => {
        const id = nextId.current++;
        setToasts((prev) => [...prev, { id, message }]);
        setTimeout(() => {
          setToasts((prev) => prev.filter((toast) => toast.id !== id));
        }, TOAST_LIFETIME_MS);
      }),
    [],
  );

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
