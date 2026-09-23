import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { TabBar } from "./components/TabBar";
import { WelcomePane } from "./components/WelcomePane";
import { MonacoHost } from "./editor/MonacoHost";
import { container } from "./services/container";
import type { RecentFileInfo } from "./services/ipc";

const MONACO_THEME_MAP: Record<string, string> = {
  dark: "vs-dark",
  light: "vs",
};

export function App() {
  const workspaceState = useSyncExternalStore(
    (listener) => container.workspace.subscribe(listener),
    () => container.workspace.getState(),
  );
  const themeKind = useSyncExternalStore(
    (listener) =>
      container.theme.subscribe(() => {
        listener();
      }),
    () => container.theme.getTheme(),
  );
  const [recentFiles, setRecentFiles] = useState<RecentFileInfo[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // A ref, not a plain `let`, so TS doesn't over-narrow `cancelled` to a
    // literal `false` inside the closure below (it's reassigned only in the
    // cleanup closure, which TS can't prove interleaves with this one).
    const cancelled = { current: false };
    void (async () => {
      await container.theme.initialize();
      await container.workspace.restoreSession();
      if (!cancelled.current) {
        setReady(true);
      }
    })();
    return () => {
      cancelled.current = true;
    };
  }, []);

  const refreshRecentFiles = useCallback(() => {
    void container.workspace.loadRecentFiles().then(setRecentFiles);
  }, []);

  useEffect(() => {
    if (ready && workspaceState.tabs.length === 0) {
      refreshRecentFiles();
    }
  }, [ready, workspaceState.tabs.length, refreshRecentFiles]);

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

  const activeTab =
    workspaceState.tabs.find((tab) => tab.id === workspaceState.activeId) ?? null;
  const activeModel = workspaceState.activeId
    ? (container.buffers.get(workspaceState.activeId) ?? null)
    : null;
  const monacoTheme = MONACO_THEME_MAP[themeKind] ?? "vs-dark";

  return (
    <div className="app-shell">
      <header className="app-shell__title-bar">
        <span className="app-shell__title">
          OpenMind Studio{activeTab ? ` — ${activeTab.title}` : ""}
        </span>
      </header>
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
          <WelcomePane
            recentFiles={recentFiles}
            onNewFile={() => void container.commands.execute("file.new")}
            onOpenFile={() => void container.commands.execute("file.open")}
            onOpenRecent={(path) => void container.workspace.openPath(path)}
          />
        ) : (
          <MonacoHost model={activeModel} theme={monacoTheme} />
        )}
      </main>
    </div>
  );
}
