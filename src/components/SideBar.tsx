import { useCallback, useState, type ReactNode } from "react";

import { container } from "../services/container";
import type { LayoutState, SideView } from "../services/layoutService";
import { EXPLORER_VIEWS_MENU } from "../services/menus";
import type { EditorTabView } from "../services/workspaceService";
import { ExplorerPanel } from "./ExplorerPanel";
import { EllipsisIcon } from "./icons";
import { resolveMenuEntries } from "./menuItems";
import { MenuPopup } from "./MenuPopup";
import { OpenEditorsSection } from "./OpenEditorsSection";
import { PaneSection } from "./PaneSection";
import { Sash } from "./Sash";
import { SearchView } from "./SearchView";
import { SideViewPlaceholder } from "./SideViewPlaceholder";
import { useDismissOnOutside } from "./useDismissOnOutside";

interface SideBarProps {
  layout: LayoutState;
  tabs: EditorTabView[];
  activeId: string | null;
  activeGroupId: string;
  activeDocPath: string | null;
  dirtyPaths: Set<string>;
  workspace: { name: string; path: string } | null;
}

const VIEW_TITLES: Record<SideView, string> = {
  explorer: "Explorer",
  search: "Search",
  scm: "Source Control",
  debug: "Run and Debug",
  extensions: "Extensions",
};

/**
 * VS Code's primary side bar. It shows whichever view the activity bar
 * selected: the Explorer (Open Editors, then the folder or "No Folder Opened"),
 * workspace Search, or an honest empty state for a feature that isn't built yet.
 */
export function SideBar(props: SideBarProps) {
  const { layout } = props;
  const [viewsMenu, setViewsMenu] = useState<DOMRect | null>(null);

  const closeViewsMenu = useCallback(() => {
    setViewsMenu(null);
  }, []);
  useDismissOnOutside(viewsMenu !== null, closeViewsMenu);

  return (
    <aside
      className={layout.sidebarPosition === "right" ? "sidebar sidebar--right" : "sidebar"}
      style={{ width: layout.sidebarWidth }}
      aria-label={VIEW_TITLES[layout.activeView]}
    >
      <div className="sidebar__title">
        <h2 className="sidebar__title-label">{VIEW_TITLES[layout.activeView]}</h2>
        {layout.activeView === "explorer" ? (
          <button
            type="button"
            className="sidebar__title-action"
            title="Views and More Actions..."
            aria-label="Views and More Actions"
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
        <SideViewContent view={layout.activeView} explorer={<ExplorerContent {...props} />} />
      </div>
      <Sash side={layout.sidebarPosition === "right" ? "left" : "right"} />
      {viewsMenu ? (
        <MenuPopup
          items={resolveMenuEntries(EXPLORER_VIEWS_MENU)}
          x={viewsMenu.left}
          y={viewsMenu.bottom}
          ariaLabel="Views"
          onClose={closeViewsMenu}
        />
      ) : null}
    </aside>
  );
}

function SideViewContent({ view, explorer }: { view: SideView; explorer: ReactNode }) {
  switch (view) {
    case "explorer":
      return explorer;
    case "search":
      return <SearchView />;
    case "scm":
      return (
        <SideViewPlaceholder
          heading="Source Control"
          message="Git client is not enabled yet."
          hint="Repositories, commits and branches will appear here once it is."
        />
      );
    case "debug":
      return (
        <SideViewPlaceholder
          heading="Run and Debug"
          message="Debugging is not available yet."
          hint="There is no debugger in this version, so there is nothing to start or configure."
        />
      );
    case "extensions":
      return (
        <SideViewPlaceholder
          heading="Extensions"
          message="Extensions are not available yet."
          hint="There is no extension system or marketplace in this version."
        />
      );
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
    <PaneSection title="No Folder Opened" expanded={expanded} onToggle={onToggle} grow>
      <div className="no-folder">
        <p>You have not yet opened a folder.</p>
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
