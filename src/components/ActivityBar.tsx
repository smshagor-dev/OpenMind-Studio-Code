import { useCallback, useState } from "react";

import { container } from "../services/container";
import { MANAGE_MENU } from "../services/menus";
import { FilesIcon, GearIcon } from "./icons";
import { resolveMenuEntries } from "./menuItems";
import { MenuPopup } from "./MenuPopup";
import { useDismissOnOutside } from "./useDismissOnOutside";

interface ActivityBarProps {
  sidebarVisible: boolean;
}

/**
 * VS Code's leftmost icon rail. Only views that actually exist get an icon
 * (Explorer); the Manage gear at the bottom opens the same menu VS Code's does,
 * with entries for not-yet-built features shown disabled.
 */
export function ActivityBar({ sidebarVisible }: ActivityBarProps) {
  const [manageAnchor, setManageAnchor] = useState<DOMRect | null>(null);

  const closeManage = useCallback(() => {
    setManageAnchor(null);
  }, []);
  useDismissOnOutside(manageAnchor !== null, closeManage);

  return (
    <nav className="activity-bar" aria-label="Activity bar">
      <div className="activity-bar__top">
        <button
          type="button"
          className={
            sidebarVisible ? "activity-bar__item activity-bar__item--active" : "activity-bar__item"
          }
          title="Explorer (Ctrl+Shift+E)"
          aria-label="Explorer"
          aria-pressed={sidebarVisible}
          onClick={() => {
            // Same as VS Code: clicking the active view's icon hides the side bar.
            container.run(sidebarVisible ? "view.toggleSidebar" : "view.showExplorer");
          }}
        >
          <FilesIcon />
        </button>
      </div>
      <div className="activity-bar__bottom">
        <button
          type="button"
          className="activity-bar__item"
          title="Manage"
          aria-label="Manage"
          aria-haspopup="menu"
          onMouseDown={(event) => {
            event.stopPropagation();
            setManageAnchor(manageAnchor ? null : event.currentTarget.getBoundingClientRect());
          }}
        >
          <GearIcon />
        </button>
      </div>
      {manageAnchor ? (
        <MenuPopup
          items={resolveMenuEntries(MANAGE_MENU)}
          x={manageAnchor.right + 2}
          y={manageAnchor.top}
          ariaLabel="Manage"
          onClose={closeManage}
        />
      ) : null}
    </nav>
  );
}
