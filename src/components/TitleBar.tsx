import { useSyncExternalStore } from "react";

import appIcon from "../../src-tauri/icons/32x32.png";
import { container } from "../services/container";
import type { TopLevelMenu } from "../services/menus";
import {
  ChromeCloseIcon,
  ChromeMaximizeIcon,
  ChromeMinimizeIcon,
  ChromeRestoreIcon,
  LayoutSidebarIcon,
  SearchIcon,
} from "./icons";
import { MenuBar } from "./MenuBar";

interface TitleBarProps {
  menus: TopLevelMenu[];
  /** Shown in the command center — the workspace folder name, or the product name. */
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
  const paletteEnabled = container.commands.isEnabled("workbench.commandPalette");

  return (
    <header className="titlebar" data-tauri-drag-region>
      <img className="titlebar__icon" src={appIcon} alt="" draggable={false} />
      <MenuBar menus={menus} onMenuOpen={onMenuOpen} />
      <div className="titlebar__drag" data-tauri-drag-region />
      <button
        type="button"
        className="command-center"
        title={paletteEnabled ? "Show All Commands (Ctrl+Shift+P)" : title}
        onClick={() => {
          if (paletteEnabled) container.run("workbench.commandPalette");
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
