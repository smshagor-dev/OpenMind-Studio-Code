import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";

import "../styles/extensionViews.css";

import { container } from "../services/container";
import type { SideView } from "../services/layoutService";
import { MANAGE_MENU } from "../services/menus";
import {
  DebugIcon,
  ExtensionsIcon,
  FilesIcon,
  GearIcon,
  RemoteIcon,
  RuntimeIcon,
  SearchIcon,
  ServerIcon,
  SourceControlIcon,
} from "./icons";
import { resolveMenuEntries } from "./menuItems";
import { MenuPopup } from "./MenuPopup";
import { withShortcut } from "./shortcutLabel";
import { useDismissOnOutside } from "./useDismissOnOutside";

interface ViewItem {
  view: SideView;
  label: string;
  /** The command whose shortcut the tooltip shows. */
  command?: string;
  icon: ReactNode;
}

const VIEW_ITEMS: readonly ViewItem[] = [
  { view: "explorer", label: "Explorer", command: "view.showExplorer", icon: <FilesIcon /> },
  { view: "search", label: "Search", command: "search.findInFiles", icon: <SearchIcon /> },
  {
    view: "scm",
    label: "Source Control",
    command: "view.showSourceControl",
    icon: <SourceControlIcon />,
  },
  { view: "debug", label: "Run and Debug", command: "view.showRun", icon: <DebugIcon /> },
  {
    view: "extensions",
    label: "Extensions",
    command: "view.showExtensions",
    icon: <ExtensionsIcon />,
  },
];

/** Items whose feature doesn't exist yet: shown, but disabled, with the reason as their tooltip. */
const UNAVAILABLE_ITEMS: readonly { label: string; reason: string; icon: ReactNode }[] = [
  {
    label: "Remote Explorer",
    reason: "Remote Explorer isn't available yet — remote connections aren't supported.",
    icon: <RemoteIcon />,
  },
];

/**
 * VS Code's leftmost icon rail. Each view icon switches the side bar to that
 * view (clicking the active one hides the side bar). Runtime Manager opens its
 * dialog. Features that don't exist yet are disabled with a reason rather
 * than faked; the Manage gear at the bottom opens the usual menu.
 */
export function ActivityBar({ sidebarVisible }: { sidebarVisible: boolean }) {
  const layout = useSyncExternalStore(
    (listener) => container.layout.subscribe(listener),
    () => container.layout.getState(),
  );
  const [manageAnchor, setManageAnchor] = useState<DOMRect | null>(null);
  const closeManage = useCallback(() => {
    setManageAnchor(null);
  }, []);
  useDismissOnOutside(manageAnchor !== null, closeManage);
  const views = container.extensions.views;
  useSyncExternalStore(
    (listener) => views.subscribe(listener),
    () => views.getVersion(),
  );

  return (
    <nav className="activity-bar" aria-label="Activity bar">
      <div className="activity-bar__top">
        {VIEW_ITEMS.map((item) => {
          const active = sidebarVisible && layout.activeView === item.view;
          return (
            <button
              key={item.view}
              type="button"
              className={
                active ? "activity-bar__item activity-bar__item--active" : "activity-bar__item"
              }
              title={item.command ? withShortcut(item.label, item.command) : item.label}
              aria-label={item.label}
              aria-pressed={active}
              onClick={() => {
                void container.layout.toggleView(item.view);
              }}
            >
              {item.icon}
            </button>
          );
        })}
        {views.containers().map((entry) => {
          const active = sidebarVisible && layout.activeView === entry.key;
          const icon = views.iconOf(entry);
          return (
            <button
              key={entry.key}
              type="button"
              className={
                active ? "activity-bar__item activity-bar__item--active" : "activity-bar__item"
              }
              title={entry.container.title}
              aria-label={entry.container.title}
              aria-pressed={active}
              onClick={() => {
                void container.layout.toggleView(entry.key);
              }}
            >
              {icon === null ? (
                <ExtensionsIcon />
              ) : icon.startsWith("data:image/svg") ? (
                <span
                  className="activity-bar__ext-icon"
                  style={{ maskImage: `url("${icon}")`, WebkitMaskImage: `url("${icon}")` }}
                />
              ) : (
                <span
                  className="activity-bar__ext-icon activity-bar__ext-icon--image"
                  style={{ backgroundImage: `url("${icon}")` }}
                />
              )}
            </button>
          );
        })}
        {UNAVAILABLE_ITEMS.map((item) => (
          <button
            key={item.label}
            type="button"
            className="activity-bar__item"
            title={item.reason}
            aria-label={item.label}
            disabled
          >
            {item.icon}
          </button>
        ))}
        <button
          type="button"
          className="activity-bar__item"
          title="PHP Server (opens in its own window)"
          aria-label="PHP Server"
          onClick={() => {
            container.run("php.openWindow");
          }}
        >
          <ServerIcon />
        </button>
        <button
          type="button"
          className="activity-bar__item"
          title="Runtime Manager"
          aria-label="Runtime Manager"
          onClick={() => {
            container.run("runtime.manage");
          }}
        >
          <RuntimeIcon />
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
