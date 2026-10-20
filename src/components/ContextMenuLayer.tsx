import { useSyncExternalStore } from "react";

import { useT } from "../i18n";
import { contextMenu, installEditorMenu } from "../services/editorMenu";
import type { MenuEntry } from "../services/menus";
import { resolveContextEntries } from "./contextMenuItems";
import { MenuPopup } from "./MenuPopup";
import { useDismissOnOutside } from "./useDismissOnOutside";

interface OpenMenuProps {
  x: number;
  y: number;
  ariaLabel: string;
  entries: () => MenuEntry[];
}

function OpenMenu({ x, y, ariaLabel, entries }: OpenMenuProps) {
  const close = () => {
    contextMenu.close(true);
  };
  useDismissOnOutside(true, close);
  const { reasonForFile } = installEditorMenu();
  return (
    <MenuPopup
      items={resolveContextEntries(entries(), reasonForFile)}
      x={x}
      y={y}
      ariaLabel={ariaLabel}
      autoFocus
      onClose={close}
    />
  );
}

/** The one open context menu of the window (editor text, a tab ...), above every panel and overlay. */
export function ContextMenuLayer() {
  useT();
  const { request } = useSyncExternalStore(
    (listener) => contextMenu.subscribe(listener),
    () => contextMenu.getState(),
  );
  if (request === null) return null;
  return (
    <OpenMenu
      key={`${String(request.x)}:${String(request.y)}`}
      x={request.x}
      y={request.y}
      ariaLabel={request.ariaLabel}
      entries={request.entries}
    />
  );
}
