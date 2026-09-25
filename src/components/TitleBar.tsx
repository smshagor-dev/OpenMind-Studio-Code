import { useSyncExternalStore, type ReactNode } from "react";

import appIcon from "../../src-tauri/icons/32x32.png";
import { container } from "../services/container";
import type { TopLevelMenu } from "../services/menus";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChromeCloseIcon,
  ChromeMaximizeIcon,
  ChromeMinimizeIcon,
  ChromeRestoreIcon,
  LayoutPanelIcon,
  LayoutSecondaryIcon,
  LayoutSidebarIcon,
  SearchIcon,
} from "./icons";
import { MenuBar } from "./MenuBar";

interface TitleBarProps {
  menus: TopLevelMenu[];
  /** Shown in the command center — the workspace folder name, or "Search" (as in VS Code). */
  title: string;
  sidebarVisible: boolean;
  sidebarRight: boolean;
  onMenuOpen: () => void;
}

/**
 * VS Code's Windows custom title bar: app icon + menu bar on the left, the
 * command center in the middle, layout toggle and window controls on the
 * right. Everything that isn't a control is a native drag region
 * (`data-tauri-drag-region`), so the undecorated window still moves and
 * double-click-maximizes like a normal one.
 */
export function TitleBar({
  menus,
  title,
  sidebarVisible,
  sidebarRight,
  onMenuOpen,
}: TitleBarProps) {
  const windowState = useSyncExternalStore(
    (listener) => container.window.subscribe(listener),
    () => container.window.getState(),
  );
  const panel = useSyncExternalStore(
    (listener) => container.panel.subscribe(listener),
    () => container.panel.getState(),
  );
  const secondary = useSyncExternalStore(
    (listener) => container.secondarySideBar.subscribe(listener),
    () => container.secondarySideBar.getState(),
  );
  const paletteEnabled = container.commands.isEnabled("workbench.commandPalette");

  return (
    <header className="titlebar" data-tauri-drag-region>
      <img className="titlebar__icon" src={appIcon} alt="" draggable={false} />
      <MenuBar menus={menus} onMenuOpen={onMenuOpen} />
      <div className="titlebar__drag" data-tauri-drag-region />
      <div className="titlebar__nav">
        <NavButton command="go.back" label="Go Back (Alt+LeftArrow)" icon={<ArrowLeftIcon />} />
        <NavButton
          command="go.forward"
          label="Go Forward (Alt+RightArrow)"
          icon={<ArrowRightIcon />}
        />
      </div>
      <button
        type="button"
        className="command-center"
        title={paletteEnabled ? "Show All Commands (Ctrl+Shift+P)" : "Search Files (Ctrl+Shift+F)"}
        onClick={() => {
          container.run(paletteEnabled ? "workbench.commandPalette" : "view.showSearch");
        }}
      >
        <SearchIcon />
        <span className="command-center__label">{title}</span>
      </button>
      <div className="titlebar__drag" data-tauri-drag-region />
      <div className="titlebar__layout-controls">
        <button
          type="button"
          className={
            sidebarVisible ? "titlebar__action titlebar__action--checked" : "titlebar__action"
          }
          title="Toggle Primary Side Bar (Ctrl+B)"
          aria-label="Toggle Primary Side Bar"
          aria-pressed={sidebarVisible}
          onClick={() => {
            container.run("view.toggleSidebar");
          }}
        >
          <LayoutSidebarIcon right={sidebarRight} />
        </button>
        <button
          type="button"
          className={
            panel.visible ? "titlebar__action titlebar__action--checked" : "titlebar__action"
          }
          title="Toggle Panel (Ctrl+J)"
          aria-label="Toggle Panel"
          aria-pressed={panel.visible}
          onClick={() => {
            container.run("view.togglePanel");
          }}
        >
          <LayoutPanelIcon visible={panel.visible} />
        </button>
        <button
          type="button"
          className={
            secondary.visible ? "titlebar__action titlebar__action--checked" : "titlebar__action"
          }
          title="Toggle Secondary Side Bar (Ctrl+Alt+B)"
          aria-label="Toggle Secondary Side Bar"
          aria-pressed={secondary.visible}
          onClick={() => {
            container.run("view.toggleSecondarySidebar");
          }}
        >
          <LayoutSecondaryIcon visible={secondary.visible} />
        </button>
      </div>
      {windowState.fullscreen ? null : (
        <div className="window-controls">
          <button
            type="button"
            className="window-controls__button"
            aria-label="Minimize"
            onClick={() => void container.window.minimize()}
          >
            <ChromeMinimizeIcon />
          </button>
          <button
            type="button"
            className="window-controls__button"
            aria-label={windowState.maximized ? "Restore" : "Maximize"}
            onClick={() => void container.window.toggleMaximize()}
          >
            {windowState.maximized ? <ChromeRestoreIcon /> : <ChromeMaximizeIcon />}
          </button>
          <button
            type="button"
            className="window-controls__button window-controls__button--close"
            aria-label="Close"
            onClick={() => void container.window.close()}
          >
            <ChromeCloseIcon />
          </button>
        </div>
      )}
    </header>
  );
}

/** Back/Forward: enabled only when the navigation command exists (disabled with its reason otherwise). */
function NavButton(props: { command: string; label: string; icon: ReactNode }) {
  const enabled = container.commands.isEnabled(props.command);
  return (
    <button
      type="button"
      className="titlebar__action"
      title={enabled ? props.label : `${props.label} — no navigation history yet`}
      aria-label={props.label}
      disabled={!enabled}
      onClick={() => {
        container.run(props.command);
      }}
    >
      {props.icon}
    </button>
  );
}
