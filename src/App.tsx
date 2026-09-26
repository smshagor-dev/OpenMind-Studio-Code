import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  useAboutDialog,
  useAppStartup,
  useCommandStateRefresh,
  useGlobalKeybindings,
  useRecents,
  useRunConfigurationDialog,
  useLanguageToolsDialog,
  useRuntimeManagerDialog,
  useToasts,
  useWorkbenchState,
} from "./appHooks";
import { AboutDialog } from "./components/AboutDialog";
import { ActivityBar } from "./components/ActivityBar";
import { BottomPanel } from "./components/BottomPanel";
import { EditorArea } from "./components/EditorArea";
import { ErrorToast } from "./components/ErrorToast";
import { QuickOpen } from "./components/QuickOpen";
import { ExtensionDialogs } from "./components/ExtensionDialogs";
import { ExtensionPrompts } from "./components/ExtensionPrompts";
import { RunConfigurationDialog } from "./components/RunConfigurationDialog";
import { LanguageToolsDialog } from "./components/LanguageToolsDialog";
import { RuntimeManagerDialog } from "./components/RuntimeManagerDialog";
import { SecondarySideBar } from "./components/SecondarySideBar";
import { SideBar } from "./components/SideBar";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { container } from "./services/container";
import { buildMenuBar } from "./services/menus";

/** The VS Code-style workbench: title bar, activity bar, side bar, editor group, status bar. */
export function App() {
  const { workspaceState, activeWorkspace, themeKind, layout } = useWorkbenchState();
  const ready = useAppStartup();
  const [toasts, dismissToast] = useToasts();
  const [recents, refreshRecents] = useRecents();
  const [aboutOpen, closeAbout] = useAboutDialog();
  const [runtimesOpen, closeRuntimes] = useRuntimeManagerDialog();
  const [languageToolsOpen, closeLanguageTools] = useLanguageToolsDialog();
  const [runConfigOpen, closeRunConfig] = useRunConfigurationDialog();
  const secondary = useSyncExternalStore(
    (listener) => container.secondarySideBar.subscribe(listener),
    () => container.secondarySideBar.getState(),
  );
  const focused = useWindowFocused();
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
    <div className={focused ? "workbench" : "workbench workbench--inactive"}>
      <TitleBar
        menus={menus}
        title={activeWorkspace?.name ?? "Search"}
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
        <div className="workbench__side">
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
        </div>
        <div
          className={
            secondary.visible && secondary.half
              ? "workbench__main workbench__main--split"
              : "workbench__main"
          }
        >
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
        {secondary.visible ? (
          <SecondarySideBar onLeft={layout.sidebarPosition === "right"} />
        ) : null}
      </div>
      {layout.statusBarVisible ? (
        <StatusBar
          activeDocument={activeTab?.kind === "text" ? activeTab : null}
          hasWorkspace={activeWorkspace !== null}
        />
      ) : null}
      <ErrorToast toasts={toasts} onDismiss={dismissToast} />
      <QuickOpen />
      <ExtensionDialogs />
      <ExtensionPrompts />
      {aboutOpen ? <AboutDialog onClose={closeAbout} /> : null}
      {runtimesOpen ? <RuntimeManagerDialog onClose={closeRuntimes} /> : null}
      {languageToolsOpen ? <LanguageToolsDialog onClose={closeLanguageTools} /> : null}
      {runConfigOpen ? <RunConfigurationDialog onClose={closeRunConfig} /> : null}
    </div>
  );
}

/** Whether this window has focus (VS Code darkens the frame of an unfocused window). */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => {
      setFocused(true);
    };
    const onBlur = () => {
      setFocused(false);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return focused;
}
