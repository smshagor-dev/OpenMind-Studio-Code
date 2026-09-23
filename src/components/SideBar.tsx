import { useCallback, useState } from "react";

import { container } from "../services/container";
import type { DocumentSnapshot } from "../services/documentService";
import type { LayoutState } from "../services/layoutService";
import { EXPLORER_VIEWS_MENU } from "../services/menus";
import { ExplorerPanel } from "./ExplorerPanel";
import { EllipsisIcon } from "./icons";
import { resolveMenuEntries } from "./menuItems";
import { MenuPopup } from "./MenuPopup";
import { OpenEditorsSection } from "./OpenEditorsSection";
import { PaneSection } from "./PaneSection";
import { Sash } from "./Sash";
import { useDismissOnOutside } from "./useDismissOnOutside";

interface SideBarProps {
  layout: LayoutState;
  tabs: DocumentSnapshot[];
  activeId: string | null;
  activeDocPath: string | null;
  dirtyPaths: Set<string>;
  workspace: { name: string; path: string } | null;
}

/** VS Code's primary side bar hosting the Explorer view: title row, Open Editors, then the folder (or "No Folder Opened"). */
export function SideBar({
  layout,
  tabs,
  activeId,
  activeDocPath,
  dirtyPaths,
  workspace,
}: SideBarProps) {
  const [viewsMenu, setViewsMenu] = useState<DOMRect | null>(null);

  const closeViewsMenu = useCallback(() => {
    setViewsMenu(null);
  }, []);
  useDismissOnOutside(viewsMenu !== null, closeViewsMenu);

  return (
    <aside
      className={layout.sidebarPosition === "right" ? "sidebar sidebar--right" : "sidebar"}
      style={{ width: layout.sidebarWidth }}
      aria-label="Explorer"
    >
      <div className="sidebar__title">
        <h2 className="sidebar__title-label">Explorer</h2>
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
      </div>
      <div className="sidebar__content">
        {layout.openEditorsVisible ? (
          <OpenEditorsSection
            tabs={tabs}
            activeId={activeId}
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
