import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";

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
import { useT } from "./i18n";
import { ActivityBar } from "./components/ActivityBar";
import { BottomPanel } from "./components/BottomPanel";
import { EditorArea } from "./components/EditorArea";
import { ErrorToast } from "./components/ErrorToast";
import { AiConfirmDialog } from "./components/ai/AiConfirmDialog";
import { FormatterDialog } from "./components/formatting/FormatterDialog";
import { ProfilesDialog } from "./components/profiles/ProfilesDialog";
import { DataScopeDialog } from "./dataScope/DataScopeDialog";
import { tauriWorkbenchApi } from "./dataScope/dataScopeApi";
import { NetworkDialog, NetworkFailureCard } from "./components/network/NetworkDialog";
import { DependencyCard } from "./components/deps/DependencyCard";
import { DependencySetupCard } from "./components/deps/DependencySetupCard";
import { LanguageToolsPromptCard } from "./components/LanguageToolsPromptCard";
import { FirstRunWorkloads } from "./components/workloads/WorkloadsPage";
import { LanguageStatusDialog } from "./components/language/LanguageStatusDialog";
import { AiProviderManager } from "./components/ai/AiProviderManager";
import { QuickOpen } from "./components/QuickOpen";
import { ExtensionDialogs } from "./components/ExtensionDialogs";
import { ExtensionPrompts } from "./components/ExtensionPrompts";
import { SecondarySideBar } from "./components/SecondarySideBar";
import { SideBar } from "./components/SideBar";
import { StatusBar } from "./components/StatusBar";
import { TitleBar } from "./components/TitleBar";
import { container } from "./services/container";
import { buildMenuBar, projectMenuCommands } from "./services/menus";

// Dialogs that only open on a click are loaded then (a separate chunk each), not at start-up.
const AboutDialog = lazy(() =>
  import("./components/AboutDialog").then((m) => ({ default: m.AboutDialog })),
);
const RunConfigurationDialog = lazy(() =>
  import("./components/RunConfigurationDialog").then((m) => ({
    default: m.RunConfigurationDialog,
  })),
);
const LanguageToolsDialog = lazy(() =>
  import("./components/LanguageToolsDialog").then((m) => ({ default: m.LanguageToolsDialog })),
);
const RuntimeManagerDialog = lazy(() =>
  import("./components/RuntimeManagerDialog").then((m) => ({ default: m.RuntimeManagerDialog })),
);

/** The VS Code-style workbench: title bar, activity bar, side bar, editor group, status bar. */
export function App() {
  useT();
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

  const shells = useSyncExternalStore(
    (listener) => container.terminal.subscribe(listener),
    () => container.terminal.getState().shells,
  );
  const languageState = useSyncExternalStore(
    (listener) => container.language.support.subscribe(listener),
    () => container.language.support.getState(),
  );
  const projects = languageState.workspace?.projects;
  const menus = useMemo(
    () =>
      buildMenuBar(
        { folders: recents.folders, files: recents.files },
        {
          shells: shells.map((shell) => ({ kind: shell.kind, label: shell.label })),
          projectCommands: projectMenuCommands(projects ?? []),
        },
      ),
    [recents, shells, projects],
  );
  const dirtyPaths = new Set(
    allTabs.flatMap((tab) => (tab.dirty && tab.path !== null ? [tab.path] : [])),
  );

  return (
    <div
      className={[
        "workbench",
        focused ? "" : "workbench--inactive",
        layout.zenMode ? "workbench--zen" : "",
        layout.centeredLayout ? "workbench--centered" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <TitleBar
        menus={menus}
        title={activeWorkspace?.name ?? "Search"}
        sidebarVisible={layout.sidebarVisible}
        sidebarRight={layout.sidebarPosition === "right"}
        onMenuOpen={refreshRecents}
      />
      <div
        className={[
          "workbench__body",
          layout.sidebarPosition === "right" ? "workbench__body--sidebar-right" : "",
          secondary.visible ? "workbench__body--secondary-visible" : "",
        ]
          .filter(Boolean)
          .join(" ")}
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
      <AiProviderManager />
      <AiConfirmDialog />
      <LanguageStatusDialog />
      <FormatterDialog />
      <ProfilesDialog />
      <DataScopeDialog service={container.dataScope} api={tauriWorkbenchApi} />
      <NetworkDialog />
      <NetworkFailureCard />
      <DependencyCard />
      <DependencySetupCard />
      <LanguageToolsPromptCard />
      <FirstRunWorkloads />
      <ExtensionDialogs />
      <ExtensionPrompts />
      <Suspense fallback={null}>
        {aboutOpen ? <AboutDialog onClose={closeAbout} /> : null}
        {runtimesOpen ? <RuntimeManagerDialog onClose={closeRuntimes} /> : null}
        {languageToolsOpen ? <LanguageToolsDialog onClose={closeLanguageTools} /> : null}
        {runConfigOpen ? <RunConfigurationDialog onClose={closeRunConfig} /> : null}
      </Suspense>
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
