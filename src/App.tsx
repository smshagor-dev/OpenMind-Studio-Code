import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ActivityBar } from "./components/ActivityBar";
import { ErrorToast, type ToastMessage } from "./components/ErrorToast";
import { ExplorerPanel } from "./components/ExplorerPanel";
import { StartPage } from "./components/StartPage";
import { TabBar } from "./components/TabBar";
import { MonacoHost } from "./editor/MonacoHost";
import { container } from "./services/container";
import type { RecentFileInfo, WorkspaceInfo } from "./services/ipc";

const MONACO_THEME_MAP: Record<string, string> = {
  dark: "vs-dark",
  light: "vs",
};

const SIDEBAR_VISIBLE_KEY = "sidebar.visible";
const TOAST_LIFETIME_MS = 6000;

export function App() {
  const workspaceState = useSyncExternalStore(
    (listener) => container.workspace.subscribe(listener),
    () => container.workspace.getState(),
  );
  const activeWorkspace = useSyncExternalStore(
    (listener) => container.workspace.subscribeWorkspace(listener),
    () => container.workspace.getActiveWorkspace(),
  );
  const themeKind = useSyncExternalStore(
    (listener) =>
      container.theme.subscribe(() => {
        listener();
      }),
    () => container.theme.getTheme(),
  );
  const [recentFiles, setRecentFiles] = useState<RecentFileInfo[]>([]);
  const [recentFolders, setRecentFolders] = useState<WorkspaceInfo[]>([]);
  const [ready, setReady] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextToastId = useRef(0);

  useEffect(() => {
    const cancelled = { current: false };
    void (async () => {
      await container.theme.initialize();
      await container.workspace.restoreActiveWorkspace();
      await container.workspace.restoreSession();
      const savedSidebar = await container.ipc.settingsGet(SIDEBAR_VISIBLE_KEY);
      if (!cancelled.current) {
        if (savedSidebar !== null) {
          setSidebarVisible(savedSidebar === "true");
        }
        setReady(true);
      }
    })();
    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(
    () =>
      container.events.on("appError", ({ message }) => {
        const id = nextToastId.current++;
        setToasts((prev) => [...prev, { id, message }]);
        setTimeout(() => {
          setToasts((prev) => prev.filter((toast) => toast.id !== id));
        }, TOAST_LIFETIME_MS);
      }),
    [],
  );

  const refreshRecents = useCallback(() => {
    void container.workspace.loadRecentFiles().then(setRecentFiles);
    void container.workspace.loadRecentFolders().then(setRecentFolders);
  }, []);

  useEffect(() => {
    if (ready && workspaceState.tabs.length === 0) {
      refreshRecents();
    }
  }, [ready, workspaceState.tabs.length, refreshRecents]);

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((prev) => {
      const next = !prev;
      void container.ipc.settingsSet(SIDEBAR_VISIBLE_KEY, String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "s" && event.shiftKey) {
        event.preventDefault();
        void container.commands.execute("file.saveAs");
      } else if (key === "s") {
        event.preventDefault();
        void container.commands.execute("file.save");
      } else if (key === "o" && event.shiftKey) {
        event.preventDefault();
        void container.commands.execute("file.openFolder");
      } else if (key === "o") {
        event.preventDefault();
        void container.commands.execute("file.open");
      } else if (key === "n") {
        event.preventDefault();
        void container.commands.execute("file.new");
      } else if (key === "w") {
        event.preventDefault();
        void container.commands.execute("file.closeActiveTab");
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const activeTab = workspaceState.tabs.find((tab) => tab.id === workspaceState.activeId) ?? null;
  const activeModel = workspaceState.activeId
    ? (container.buffers.get(workspaceState.activeId) ?? null)
    : null;
  const monacoTheme = MONACO_THEME_MAP[themeKind] ?? "vs-dark";
  const dirtyPaths = new Set(
    workspaceState.tabs
      .filter((tab) => tab.dirty && tab.path !== null)
      .map((tab) => tab.path as string),
  );

  const titleParts = ["OpenMind Studio"];
  if (activeWorkspace) titleParts.push(activeWorkspace.name);
  if (activeTab) titleParts.push(activeTab.title);

  return (
    <div className="app-shell">
      <header className="app-shell__title-bar">
        <span className="app-shell__title">{titleParts.join(" — ")}</span>
      </header>
      <div className="app-shell__body">
        <ActivityBar sidebarVisible={sidebarVisible} onToggleSidebar={toggleSidebar} />
        {sidebarVisible && activeWorkspace ? (
          <ExplorerPanel activeDocPath={activeTab?.path ?? null} dirtyPaths={dirtyPaths} />
        ) : null}
        <div className="app-shell__main">
          <TabBar
            tabs={workspaceState.tabs}
            activeId={workspaceState.activeId}
            onSelect={(id) => {
              container.workspace.setActive(id);
            }}
            onClose={(id) => {
              void container.workspace.close(id);
            }}
          />
          <main className="app-shell__content" aria-label="editor area">
            {!ready ? null : workspaceState.tabs.length === 0 ? (
              <StartPage
                recentFiles={recentFiles}
                recentFolders={recentFolders}
                onNewFile={() => void container.commands.execute("file.new")}
                onOpenFile={() => void container.commands.execute("file.open")}
                onOpenFolder={() => void container.commands.execute("file.openFolder")}
                onOpenRecentFile={(path) => void container.workspace.openPath(path)}
                onOpenRecentFolder={(path) => void container.workspace.openFolder(path)}
              />
            ) : (
              <MonacoHost model={activeModel} theme={monacoTheme} />
            )}
          </main>
        </div>
      </div>
      <ErrorToast
        toasts={toasts}
        onDismiss={(id) => {
          setToasts((prev) => prev.filter((toast) => toast.id !== id));
        }}
      />
    </div>
  );
}
