import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { CheckIcon, ChevronRightSmallIcon } from "./icons";

/** A menu row, already resolved to concrete enabled/checked state and a click handler. */
export type PopupItem =
  | {
      kind: "item";
      label: string;
      shortcut?: string;
      enabled: boolean;
      checked?: boolean;
      danger?: boolean;
      onSelect: () => void;
    }
  | { kind: "submenu"; label: string; items: PopupItem[] }
  | { kind: "separator" };

interface MenuPopupProps {
  items: PopupItem[];
  x: number;
  y: number;
  /** Close the whole menu chain (after a selection, Escape, or an outside click). */
  onClose: () => void;
  /** Left/Right pressed where the popup itself can't use it — the menu bar switches menus. */
  onNavigate?: (direction: "left" | "right") => void;
  /** Take keyboard focus on mount (keyboard-opened menus and submenus). */
  autoFocus?: boolean;
  /** For submenus: close only this level (Left arrow / Escape inside a submenu). */
  onCloseLevel?: () => void;
  ariaLabel?: string;
}

function isActionable(item: PopupItem | undefined): boolean {
  if (!item || item.kind === "separator") return false;
  return item.kind === "submenu" || item.enabled;
}

function step(items: PopupItem[], from: number, delta: number): number {
  for (let i = 1; i <= items.length; i++) {
    const index = (((from + delta * i) % items.length) + items.length) % items.length;
    if (isActionable(items[index])) return index;
  }
  return from;
}

interface OpenSubmenu {
  index: number;
  x: number;
  y: number;
  keyboard: boolean;
}

/** Focus tracking, submenu opening, activation and keyboard handling for one popup level. */
function useMenuNavigation(props: MenuPopupProps) {
  const { items, onClose, onNavigate, autoFocus, onCloseLevel } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(autoFocus ? step(items, -1, 1) : -1);
  const [openSub, setOpenSub] = useState<OpenSubmenu | null>(null);

  function openSubmenu(index: number, keyboard: boolean) {
    const row = rootRef.current?.querySelectorAll<HTMLElement>("[data-menu-index]")[index];
    if (!row) return;
    const rect = row.getBoundingClientRect();
    setOpenSub({ index, x: rect.right - 2, y: rect.top - 5, keyboard });
  }

  function activate(index: number, keyboard: boolean) {
    const item = items[index];
    if (!item || item.kind === "separator") return;
    if (item.kind === "submenu") {
      openSubmenu(index, keyboard);
      return;
    }
    if (!item.enabled) return;
    onClose();
    item.onSelect();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        setFocused((current) => step(items, current, 1));
        break;
      case "ArrowUp":
        setFocused((current) => step(items, current < 0 ? 0 : current, -1));
        break;
      case "ArrowRight":
        if (items[focused]?.kind === "submenu") openSubmenu(focused, true);
        else onNavigate?.("right");
        break;
      case "ArrowLeft":
        if (onCloseLevel) onCloseLevel();
        else onNavigate?.("left");
        break;
      case "Enter":
      case " ":
        activate(focused, true);
        break;
      case "Escape":
        if (onCloseLevel) onCloseLevel();
        else onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return {
    rootRef,
    focused,
    setFocused,
    openSub,
    setOpenSub,
    openSubmenu,
    activate,
    handleKeyDown,
  };
}

/** VS Code-style dropdown: separators, check marks, shortcut labels, nested submenus, full keyboard support. */
export function MenuPopup(props: MenuPopupProps) {
  const { items, x, y, onClose, autoFocus, ariaLabel } = props;
  const nav = useMenuNavigation(props);
  const { rootRef, openSub } = nav;
  const [position, setPosition] = useState({ left: x, top: y });

  // Keep the popup inside the window (shift left / up when it would overflow).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left =
      x + rect.width > window.innerWidth ? Math.max(0, window.innerWidth - rect.width - 2) : x;
    const top =
      y + rect.height > window.innerHeight ? Math.max(0, window.innerHeight - rect.height - 2) : y;
    setPosition({ left, top });
  }, [x, y, rootRef]);

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus();
  }, [autoFocus, rootRef]);

  const sub = openSub ? items[openSub.index] : undefined;

  return (
    <>
      <div
        ref={rootRef}
        className="menu-popup"
        role="menu"
        aria-label={ariaLabel}
        tabIndex={-1}
        style={{ left: position.left, top: position.top }}
        onKeyDown={nav.handleKeyDown}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
      >
        {items.map((item, index) => (
          <MenuRow
            key={item.kind === "separator" ? `sep-${index}` : `${item.label}-${index}`}
            item={item}
            index={index}
            focused={index === nav.focused}
            onHover={() => {
              nav.setFocused(index);
              if (item.kind === "submenu") nav.openSubmenu(index, false);
              else nav.setOpenSub(null);
            }}
            onActivate={() => {
              nav.activate(index, false);
            }}
          />
        ))}
      </div>
      {openSub && sub?.kind === "submenu" ? (
        <MenuPopup
          key={openSub.index}
          items={sub.items}
          x={openSub.x}
          y={openSub.y}
          autoFocus={openSub.keyboard}
          onClose={onClose}
          onCloseLevel={() => {
            nav.setOpenSub(null);
            rootRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

interface MenuRowProps {
  item: PopupItem;
  index: number;
  focused: boolean;
  onHover: () => void;
  onActivate: () => void;
}

function MenuRow({ item, index, focused, onHover, onActivate }: MenuRowProps) {
  if (item.kind === "separator") {
    return <div className="menu-popup__separator" role="separator" />;
  }
  const isItem = item.kind === "item";
  const disabled = isItem && !item.enabled;
  const checkable = isItem && item.checked !== undefined;
  const className = [
    "menu-popup__item",
    focused ? "menu-popup__item--focused" : "",
    disabled ? "menu-popup__item--disabled" : "",
    isItem && item.danger ? "menu-popup__item--danger" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      data-menu-index={index}
      className={className}
      role={checkable ? "menuitemcheckbox" : "menuitem"}
      aria-checked={checkable ? item.checked : undefined}
      aria-disabled={disabled || undefined}
      aria-haspopup={isItem ? undefined : true}
      onMouseEnter={onHover}
      onClick={onActivate}
    >
      <span className="menu-popup__check">{isItem && item.checked ? <CheckIcon /> : null}</span>
      <span className="menu-popup__label">{item.label}</span>
      {isItem && item.shortcut ? (
        <span className="menu-popup__shortcut">{item.shortcut}</span>
      ) : null}
      {isItem ? null : (
        <span className="menu-popup__submenu-arrow">
          <ChevronRightSmallIcon />
        </span>
      )}
    </div>
  );
}
