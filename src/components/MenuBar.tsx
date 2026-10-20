import { useCallback, useEffect, useRef, useState } from "react";

import type { TopLevelMenu } from "../services/menus";
import { resolveMenuEntries } from "./menuItems";
import { MenuPopup, type PopupItem } from "./MenuPopup";
import { useDismissOnOutside } from "./useDismissOnOutside";
import { MenuIcon } from "./icons";
import { t } from "../i18n";
import { topMenuLabel } from "../i18n/menuLabels";

interface MenuBarProps {
  menus: TopLevelMenu[];
  /** Called whenever a menu opens, so dynamic content (Open Recent) can refresh. */
  onMenuOpen?: () => void;
}

/** The compact button's menu (every top-level menu as a submenu) instead of one top-level menu. */
const ALL_MENUS = -1;

interface OpenState {
  index: number;
  keyboard: boolean;
  /** The menu title button's position, captured when opening (never read from refs during render). */
  anchor: DOMRect;
}

/**
 * VS Code's custom title-bar menu bar: click to open, hover to switch while
 * one is open, Alt+<mnemonic> to open from the keyboard, Left/Right to move
 * between menus, Escape / outside click to close. When the title bar is too narrow for File, Edit, ... (a small
 * window, long translated labels) they fold into one ☰ button whose menu lists them as submenus.
 */
export function MenuBar({ menus, onMenuOpen }: MenuBarProps) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const compactRef = useRef<HTMLButtonElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const compact = useCompact(barRef);

  function openMenu(index: number, keyboard: boolean) {
    const wrapped = index === ALL_MENUS ? ALL_MENUS : ((index % menus.length) + menus.length) % menus.length;
    const anchor = (compact ? compactRef.current : buttonRefs.current[wrapped])?.getBoundingClientRect();
    if (!anchor) return;
    setOpen({ index: wrapped, keyboard, anchor });
    onMenuOpen?.();
  }

  useMnemonics(menus, openMenu);

  const close = useCallback(() => {
    setOpen(null);
  }, []);
  useDismissOnOutside(open !== null, close);

  const popup = open ? popupFor(menus, open.index) : null;

  return (
    <div
      ref={barRef}
      className={compact ? "menubar menubar--compact" : "menubar"}
      role="menubar"
      aria-label={t("menu.application")}
    >
      {compact ? (
        <button
          ref={compactRef}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open !== null}
          aria-label={t("menu.application")}
          title={t("menu.application")}
          className={open ? "menubar__item menubar__compact menubar__item--open" : "menubar__item menubar__compact"}
          onMouseDown={(event) => {
            event.stopPropagation();
            if (open) close();
            else openMenu(ALL_MENUS, false);
          }}
        >
          <MenuIcon />
        </button>
      ) : (
        menus.map((menu, index) => (
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
        ))
      )}
      {open && popup ? (
        <MenuPopup
          key={`${open.index}-${String(open.keyboard)}`}
          items={popup.items}
          x={open.anchor.left}
          y={open.anchor.bottom}
          autoFocus={open.keyboard}
          ariaLabel={popup.label}
          onClose={close}
          onNavigate={(direction) => {
            if (open.index !== ALL_MENUS) openMenu(open.index + (direction === "right" ? 1 : -1), true);
          }}
        />
      ) : null}
    </div>
  );
}

/** One top-level menu's rows, or (`ALL_MENUS`) every top-level menu as a submenu of the compact button. */
function popupFor(menus: TopLevelMenu[], index: number): { items: PopupItem[]; label: string } | null {
  if (index === ALL_MENUS) {
    return {
      label: t("menu.application"),
      items: menus.map((menu) => ({
        kind: "submenu",
        label: topMenuLabel(menu.id, menu.label),
        items: resolveMenuEntries(menu.items),
      })),
    };
  }
  const menu = menus[index];
  return menu ? { items: resolveMenuEntries(menu.items), label: topMenuLabel(menu.id, menu.label) } : null;
}

/**
 * Whether the menus must fold into the ☰ button: they overflow the menu bar (it shrinks first: the title bar keeps its
 * buttons and window controls). Folded, they come back once the title bar's free space (its drag areas) can hold the
 * width they needed. Measured, so long translated labels fold earlier than English ones.
 */
function useCompact(barRef: React.RefObject<HTMLDivElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  const needed = useRef(0);
  useEffect(() => {
    const bar = barRef.current;
    const titlebar = bar?.parentElement;
    if (!bar || !titlebar || typeof ResizeObserver === "undefined") return;
    const check = () => {
      if (!compact) {
        if (bar.scrollWidth > bar.clientWidth + 1) {
          needed.current = bar.scrollWidth;
          setCompact(true);
        }
        return;
      }
      const spare = [...titlebar.children]
        .filter((child) => child.classList.contains("titlebar__drag"))
        .reduce((sum, child) => sum + Math.max(0, child.getBoundingClientRect().width - 8), 0);
      if (bar.getBoundingClientRect().width + spare >= needed.current) setCompact(false);
    };
    const observer = new ResizeObserver(check);
    observer.observe(titlebar);
    check();
    return () => {
      observer.disconnect();
    };
  }, [barRef, compact]);
  return compact;
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
