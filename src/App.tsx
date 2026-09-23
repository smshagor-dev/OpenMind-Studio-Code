import { useEffect, useMemo } from "react";

import {
  useAboutDialog,
  useAppStartup,
  useCommandStateRefresh,
  useGlobalKeybindings,
  useRecents,
  useToasts,
  useWorkbenchState,
} from "./appHooks";
import { AboutDialog } from "./components/AboutDialog";
import { ActivityBar } from "./components/ActivityBar";
import { EditorGroup } from "./components/EditorGroup";
import { ErrorToast } from "./components/ErrorToast";
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
  useGlobalKeybindings();
  useCommandStateRefresh();

  const noTabs = workspaceState.tabs.length === 0;
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
    workspaceState.tabs.flatMap((tab) => (tab.dirty && tab.path !== null ? [tab.path] : [])),
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
            tabs={workspaceState.tabs}
            activeId={workspaceState.activeId}
            activeDocPath={activeTab?.path ?? null}
            dirtyPaths={dirtyPaths}
            workspace={activeWorkspace}
          />
        ) : null}
        <EditorGroup
          ready={ready}
          tabs={workspaceState.tabs}
          activeTab={activeTab}
          rootPath={activeWorkspace?.path ?? null}
          breadcrumbsVisible={layout.breadcrumbsVisible}
          themeKind={themeKind}
          recents={recents}
        />
      </div>
      {layout.statusBarVisible ? (
        <StatusBar activeDocument={activeTab} hasWorkspace={activeWorkspace !== null} />
      ) : null}
      <ErrorToast toasts={toasts} onDismiss={dismissToast} />
      {aboutOpen ? <AboutDialog onClose={closeAbout} /> : null}
    </div>
  );
}
