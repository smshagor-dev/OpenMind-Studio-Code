import { useCallback, useEffect, useRef, useState } from "react";

import type { TopLevelMenu } from "../services/menus";
import { resolveMenuEntries } from "./menuItems";
import { MenuPopup } from "./MenuPopup";
import { useDismissOnOutside } from "./useDismissOnOutside";
import { t } from "../i18n";
import { topMenuLabel } from "../i18n/menuLabels";

interface MenuBarProps {
  menus: TopLevelMenu[];
  /** Called whenever a menu opens, so dynamic content (Open Recent) can refresh. */
  onMenuOpen?: () => void;
}

interface OpenState {
  index: number;
  keyboard: boolean;
  /** The menu title button's position, captured when opening (never read from refs during render). */
  anchor: DOMRect;
}

/**
 * VS Code's custom title-bar menu bar: click to open, hover to switch while
 * one is open, Alt+<mnemonic> to open from the keyboard, Left/Right to move
 * between menus, Escape / outside click to close.
 */
export function MenuBar({ menus, onMenuOpen }: MenuBarProps) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function openMenu(index: number, keyboard: boolean) {
    const wrapped = ((index % menus.length) + menus.length) % menus.length;
    const anchor = buttonRefs.current[wrapped]?.getBoundingClientRect();
    if (!anchor) return;
    setOpen({ index: wrapped, keyboard, anchor });
    onMenuOpen?.();
  }

  useMnemonics(menus, openMenu);

  const close = useCallback(() => {
    setOpen(null);
  }, []);
  useDismissOnOutside(open !== null, close);

  const openMenuDef = open ? menus[open.index] : undefined;

  return (
    <div className="menubar" role="menubar" aria-label={t("menu.application")}>
      {menus.map((menu, index) => (
        <button
          key={menu.id}
          ref={(element) => {
            buttonRefs.current[index] = element;
          }}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open?.index === index}
          className={open?.index === index ? "menubar__item menubar__item--open" : "menubar__item"}
          onMouseDown={(event) => {
            event.stopPropagation();
            if (open?.index === index) close();
            else openMenu(index, false);
          }}
          onMouseEnter={() => {
            if (open && open.index !== index) openMenu(index, false);
          }}
        >
          {topMenuLabel(menu.id, menu.label)}
        </button>
      ))}
      {open && openMenuDef ? (
        <MenuPopup
          key={`${open.index}-${String(open.keyboard)}`}
          items={resolveMenuEntries(openMenuDef.items)}
          x={open.anchor.left}
          y={open.anchor.bottom}
          autoFocus={open.keyboard}
          ariaLabel={topMenuLabel(openMenuDef.id, openMenuDef.label)}
          onClose={close}
          onNavigate={(direction) => {
            openMenu(open.index + (direction === "right" ? 1 : -1), true);
          }}
        />
      ) : null}
    </div>
  );
}

/** Alt+<mnemonic letter> opens the matching top-level menu with keyboard focus, as in VS Code. */
function useMnemonics(menus: TopLevelMenu[], openMenu: (index: number, keyboard: boolean) => void) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return;
      if (!event.code.startsWith("Key")) return;
      const letter = event.code.slice(3);
      const index = menus.findIndex((menu) => menu.mnemonic === letter);
      if (index >= 0) {
        event.preventDefault();
        openMenu(index, true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  });
}
