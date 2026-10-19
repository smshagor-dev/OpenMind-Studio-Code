import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";

import "../styles/extensionViews.css";

import { container } from "../services/container";
import type { SideView } from "../services/layoutService";
import { MANAGE_MENU } from "../services/menus";
import {
  AgentIcon,
  AiIcon,
  BookmarkIcon,
  DebugIcon,
  ExtensionsIcon,
  FilesIcon,
  GearIcon,
  PackageIcon,
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
import { t } from "../i18n";

interface ViewItem {
  view: SideView;
  label: string;
  /** The command whose shortcut the tooltip shows. */
  command?: string;
  icon: ReactNode;
}

const VIEW_ITEMS: readonly ViewItem[] = [
  { view: "explorer", label: "view.explorer", command: "view.showExplorer", icon: <FilesIcon /> },
  { view: "search", label: "view.search", command: "search.findInFiles", icon: <SearchIcon /> },
  {
    view: "scm",
    label: "view.sourceControl",
    command: "view.showSourceControl",
    icon: <SourceControlIcon />,
  },
  { view: "debug", label: "view.runAndDebug", command: "view.showRun", icon: <DebugIcon /> },
  {
    view: "extensions",
    label: "view.extensions",
    command: "view.showExtensions",
    icon: <ExtensionsIcon />,
  },
  {
    view: "deps",
    label: "view.dependencies",
    command: "view.showDependencies",
    icon: <PackageIcon />,
  },
  {
    view: "bookmarks",
    label: "view.bookmarks",
    command: "bookmarks.list",
    icon: <BookmarkIcon />,
  },
  { view: "collab", label: "view.collaboration", icon: <RemoteIcon /> },
  { view: "agent", label: "view.agent", icon: <AgentIcon /> },
];

const AI_ITEM: ViewItem = {
  view: "ai",
  label: "view.ai",
  command: "ai.openChat",
  icon: <AiIcon />,
};

/**
 * VS Code's leftmost icon rail. Each view icon switches the side bar to that
 * view (clicking the active one hides the side bar). Runtime Manager opens its
 * dialog. The remote (PC) icon opens the collaboration room; the Manage gear at the bottom opens the usual menu.
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
  useSyncExternalStore(
    (listener) => container.ai.providers.subscribe(listener),
    () => container.ai.providers.getVersion(),
  );
  // The AI item exists only while a provider is available: no provider, no icon, no disabled placeholder.
  const aiVisible = container.ai.providers.panelVisible();
  const views = container.extensions.views;
  useSyncExternalStore(
    (listener) => views.subscribe(listener),
    () => views.getVersion(),
  );

  return (
    <nav className="activity-bar" aria-label={t("activity.bar")}>
      <div className="activity-bar__top">
        {[...VIEW_ITEMS, ...(aiVisible ? [AI_ITEM] : [])].map((item) => {
          const active = sidebarVisible && layout.activeView === item.view;
          return (
            <button
              key={item.view}
              type="button"
              className={
                active ? "activity-bar__item activity-bar__item--active" : "activity-bar__item"
              }
              title={item.command ? withShortcut(t(item.label), item.command) : t(item.label)}
              aria-label={t(item.label)}
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
        <button
          type="button"
          className="activity-bar__item"
          title={t("activity.phpServerTitle")}
          aria-label={t("activity.phpServer")}
          onClick={() => {
            container.run("php.openWindow");
          }}
        >
          <ServerIcon />
        </button>
        <button
          type="button"
          className="activity-bar__item"
          title={t("activity.runtimeManager")}
          aria-label={t("activity.runtimeManager")}
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
          title={t("activity.manage")}
          aria-label={t("activity.manage")}
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
          ariaLabel={t("activity.manage")}
          onClose={closeManage}
        />
      ) : null}
    </nav>
  );
}
