import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";

import { container } from "../services/container";
import type { BuiltInView, LayoutState, SideView } from "../services/layoutService";
import { isExtensionView } from "../services/extensionViewsService";
import { ExtensionContainerView } from "./ExtensionContainerView";
import { EXPLORER_VIEWS_MENU } from "../services/menus";
import type { EditorTabView } from "../services/workspaceService";
import { ExplorerPanel } from "./ExplorerPanel";
import { EllipsisIcon } from "./icons";
import { resolveMenuEntries } from "./menuItems";
import { MenuPopup } from "./MenuPopup";
import { OpenEditorsSection } from "./OpenEditorsSection";
import { PaneSection } from "./PaneSection";
import { AiView } from "./AiView";
import { AgentView } from "./agent/AgentView";
import { RunDebugView } from "./RunDebugView";
import { Sash } from "./Sash";
import { SearchView } from "./SearchView";
import { SourceControlView } from "./SourceControlView";
import { ExtensionsView } from "./ExtensionsView";
import { DependenciesView } from "./deps/DependenciesView";
import { BookmarksView } from "./BookmarksView";
import { CollaborationView } from "./collab/CollaborationView";
import { useDismissOnOutside } from "./useDismissOnOutside";
import { t } from "../i18n";

interface SideBarProps {
  layout: LayoutState;
  tabs: EditorTabView[];
  activeId: string | null;
  activeGroupId: string;
  activeDocPath: string | null;
  dirtyPaths: Set<string>;
  workspace: { name: string; path: string } | null;
}

const VIEW_TITLES: Record<BuiltInView, string> = {
  explorer: "view.explorer",
  search: "view.search",
  scm: "view.sourceControl",
  debug: "view.runAndDebug",
  extensions: "view.extensions",
  deps: "view.dependencies",
  bookmarks: "view.bookmarks",
  collab: "view.collaboration",
  ai: "view.ai",
  agent: "view.agent",
};

/**
 * VS Code's primary side bar. It shows whichever view the activity bar
 * selected: the Explorer (Open Editors, then the folder or "No Folder Opened"),
 * workspace Search, or an honest empty state for a feature that isn't built yet.
 */
export function SideBar(props: SideBarProps) {
  const { layout } = props;
  const [viewsMenu, setViewsMenu] = useState<DOMRect | null>(null);
  useSyncExternalStore(
    (listener) => container.extensions.views.subscribe(listener),
    () => container.extensions.views.getVersion(),
  );
  // An extension's container whose extension is gone or disabled falls back to the Explorer.
  const extension = isExtensionView(layout.activeView)
    ? container.extensions.views.find(layout.activeView)
    : undefined;
  useSyncExternalStore(
    (listener) => container.ai.providers.subscribe(listener),
    () => container.ai.providers.getVersion(),
  );
  const aiGone = layout.activeView === "ai" && !container.ai.providers.panelVisible();
  const view: SideView =
    !aiGone && (extension || !isExtensionView(layout.activeView)) ? layout.activeView : "explorer";
  const title = extension ? extension.container.title : t(VIEW_TITLES[view as BuiltInView]);

  const closeViewsMenu = useCallback(() => {
    setViewsMenu(null);
  }, []);
  useDismissOnOutside(viewsMenu !== null, closeViewsMenu);

  return (
    <aside
      className={layout.sidebarPosition === "right" ? "sidebar sidebar--right" : "sidebar"}
      style={{ width: layout.sidebarWidth }}
      aria-label={title}
    >
      <div className="sidebar__title">
        <h2 className="sidebar__title-label">{title}</h2>
        {view === "explorer" ? (
          <button
            type="button"
            className="sidebar__title-action"
            title={t("sidebar.moreActionsTitle")}
            aria-label={t("sidebar.moreActions")}
            onMouseDown={(event) => {
              event.stopPropagation();
              setViewsMenu(viewsMenu ? null : event.currentTarget.getBoundingClientRect());
            }}
          >
            <EllipsisIcon />
          </button>
        ) : null}
      </div>
      <div className="sidebar__content">
        <SideViewContent
          view={view}
          explorer={<ExplorerContent {...props} />}
          hasFolder={props.workspace !== null}
        />
      </div>
      <Sash side={layout.sidebarPosition === "right" ? "left" : "right"} />
      {viewsMenu ? (
        <MenuPopup
          items={resolveMenuEntries(EXPLORER_VIEWS_MENU)}
          x={viewsMenu.left}
          y={viewsMenu.bottom}
          ariaLabel={t("sidebar.views")}
          onClose={closeViewsMenu}
        />
      ) : null}
    </aside>
  );
}

function SideViewContent({
  view,
  explorer,
  hasFolder,
}: {
  view: SideView;
  explorer: ReactNode;
  hasFolder: boolean;
}) {
  if (isExtensionView(view)) return <ExtensionContainerView key={view} viewKey={view} />;
  switch (view) {
    case "explorer":
      return explorer;
    case "search":
      return <SearchView />;
    case "scm":
      return <SourceControlView />;
    case "debug":
      return <RunDebugView />;
    case "extensions":
      return <ExtensionsView />;
    case "deps":
      return <DependenciesView hasFolder={hasFolder} />;
    case "bookmarks":
      return <BookmarksView />;
    case "collab":
      return <CollaborationView />;
    case "ai":
      return <AiView />;
    case "agent":
      return <AgentView />;
  }
}

function ExplorerContent({
  layout,
  tabs,
  activeId,
  activeGroupId,
  activeDocPath,
  dirtyPaths,
  workspace,
}: SideBarProps) {
  return (
    <>
      {layout.openEditorsVisible ? (
        <OpenEditorsSection
          tabs={tabs}
          activeId={activeId}
          activeGroupId={activeGroupId}
          rootPath={workspace?.path ?? null}
          expanded={layout.openEditorsExpanded}
          onToggle={() => void container.layout.toggle("openEditorsExpanded")}
        />
      ) : null}
      {workspace ? (
        <ExplorerPanel
          activeDocPath={activeDocPath}
          dirtyPaths={dirtyPaths}
          expanded={layout.folderExpanded}
          onToggle={toggleFolderSection}
        />
      ) : (
        <NoFolderSection expanded={layout.folderExpanded} onToggle={toggleFolderSection} />
      )}
    </>
  );
}

function toggleFolderSection(): void {
  void container.layout.toggle("folderExpanded");
}

function NoFolderSection({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <PaneSection title={t("sidebar.noFolder")} expanded={expanded} onToggle={onToggle} grow>
      <div className="no-folder">
        <p>{t("sidebar.noFolderText")}</p>
        <button
          type="button"
          className="button button--primary button--block"
          onClick={() => {
            container.run("file.openFolder");
          }}
        >
          Open Folder
        </button>
      </div>
    </PaneSection>
  );
}
