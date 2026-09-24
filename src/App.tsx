import { useEffect, useMemo } from "react";

import {
  useAboutDialog,
  useAppStartup,
  useCommandStateRefresh,
  useGlobalKeybindings,
  useRecents,
  useRuntimeManagerDialog,
  useToasts,
  useWorkbenchState,
} from "./appHooks";
import { AboutDialog } from "./components/AboutDialog";
import { ActivityBar } from "./components/ActivityBar";
import { BottomPanel } from "./components/BottomPanel";
import { EditorArea } from "./components/EditorArea";
import { ErrorToast } from "./components/ErrorToast";
import { RuntimeManagerDialog } from "./components/RuntimeManagerDialog";
import { SideBar } from "./components/SideBar";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { buildMenuBar } from "./services/menus";

/** The VS Code-style workbench: title bar, activity bar, side bar, editor group, status bar. */
export function App() {
  const { workspaceState, activeWorkspace, themeKind, layout } = useWorkbenchState();
  const ready = useAppStartup();
  const [toasts, dismissToast] = useToasts();
  const [recents, refreshRecents] = useRecents();
  const [aboutOpen, closeAbout] = useAboutDialog();
  const [runtimesOpen, closeRuntimes] = useRuntimeManagerDialog();
  useGlobalKeybindings();
  useCommandStateRefresh();

  const allTabs = workspaceState.groups.flatMap((group) => group.tabs);
  const noTabs = allTabs.length === 0;
  useEffect(() => {
    if (ready && noTabs) refreshRecents();
  }, [ready, noTabs, refreshRecents]);

  useEffect(() => {
    document.documentElement.dataset.theme = themeKind;
  }, [themeKind]);

  const activeTab = workspaceState.tabs.find((tab) => tab.id === workspaceState.activeId) ?? null;
  const titleParts = [activeTab?.title, activeWorkspace?.name, "OpenMind Studio"].filter(Boolean);
  useEffect(() => {
    document.title = titleParts.join(" - ");
  });

  const menus = useMemo(
    () => buildMenuBar({ folders: recents.folders, files: recents.files }),
    [recents],
  );
  const dirtyPaths = new Set(
    allTabs.flatMap((tab) => (tab.dirty && tab.path !== null ? [tab.path] : [])),
  );

  return (
    <div className="workbench">
      <TitleBar
        menus={menus}
        title={activeWorkspace?.name ?? "OpenMind Studio"}
        sidebarVisible={layout.sidebarVisible}
        sidebarRight={layout.sidebarPosition === "right"}
        onMenuOpen={refreshRecents}
      />
      <div
        className={
          layout.sidebarPosition === "right"
            ? "workbench__body workbench__body--sidebar-right"
            : "workbench__body"
        }
      >
        <ActivityBar sidebarVisible={layout.sidebarVisible} />
        {layout.sidebarVisible ? (
          <SideBar
            layout={layout}
            tabs={allTabs}
            activeId={workspaceState.activeId}
            activeGroupId={workspaceState.activeGroupId}
            activeDocPath={activeTab?.path ?? null}
            dirtyPaths={dirtyPaths}
            workspace={activeWorkspace}
          />
        ) : null}
        <div className="workbench__main">
          <EditorArea
            state={workspaceState}
            ready={ready}
            rootPath={activeWorkspace?.path ?? null}
            breadcrumbsVisible={layout.breadcrumbsVisible}
            themeKind={themeKind}
            recents={recents}
          />
          <BottomPanel themeKind={themeKind} />
        </div>
      </div>
      {layout.statusBarVisible ? (
        <StatusBar activeDocument={activeTab} hasWorkspace={activeWorkspace !== null} />
      ) : null}
      <ErrorToast toasts={toasts} onDismiss={dismissToast} />
      {aboutOpen ? <AboutDialog onClose={closeAbout} /> : null}
      {runtimesOpen ? <RuntimeManagerDialog onClose={closeRuntimes} /> : null}
    </div>
  );
}
