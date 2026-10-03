import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { droppedOutside } from "../services/editorWindowService";
import type { EditorTabView } from "../services/workspaceService";
import { FileTypeIcon } from "./fileIcons";
import { CloseIcon } from "./icons";
import { t } from "../i18n";
import { overflows, revealScrollLeft, wheelDistance } from "./tabScroll";

interface TabBarProps {
  tabs: EditorTabView[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Double-click: keep a provisional tab open. */
  onKeepOpen: (id: string) => void;
  /** A tab dragged out of the window (VS Code opens it in a new window); `at` = drop point on screen. */
  onDetach?: (id: string, at: { x: number; y: number }) => void;
}

/** The drag type of a tab, so other drop targets (the explorer) ignore it. */
const TAB_DRAG_TYPE = "application/x-openmind-tab";

function tabTitle(tab: EditorTabView): string {
  const base = tab.path ?? tab.title;
  if (tab.external === "deleted") return `${base} (deleted on disk)`;
  if (tab.external === "changed") return `${base} (changed on disk — you have unsaved changes)`;
  return tab.preview ? `${base} (preview — double-click to keep open)` : base;
}

/**
 * VS Code editor tabs: file-type icon, name, and a close button that shows
 * on the active/hovered tab — or a dot while the file is dirty, turning back
 * into × on hover. A provisional ("preview") tab is italic until it is edited
 * or double-clicked. Middle-click closes.
 *
 * When the tabs don't fit, the row scrolls sideways (the editor actions beside it stay put): the wheel — vertical,
 * Shift+wheel or a trackpad's sideways swipe — moves it without scrolling anything else, and the active tab is always
 * brought fully into view (selected, newly opened, restored, or after the window or the group was resized).
 */
export function TabBar({ tabs, activeId, onSelect, onClose, onKeepOpen, onDetach }: TabBarProps) {
  const row = useRef<HTMLDivElement | null>(null);
  const tabElements = useRef(new Map<string, HTMLDivElement>());
  const hasTabs = tabs.length > 0;

  /** Scrolls the row just enough to show the active tab whole (no-op when it is already visible). */
  const revealActive = useCallback(() => {
    const element = row.current;
    const tab = activeId === null ? undefined : tabElements.current.get(activeId);
    if (!element || !tab) return;
    const next = revealScrollLeft(element.scrollLeft, element.clientWidth, tab.offsetLeft, tab.offsetWidth);
    if (next !== null) element.scrollLeft = next;
  }, [activeId]);

  // Selecting, opening or closing a tab (and the first render of a restored session) reveals the active one.
  useLayoutEffect(() => {
    revealActive();
  }, [revealActive, tabs.length]);

  // A narrower window or editor group must not leave the active tab cut off.
  useEffect(() => {
    const element = row.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      revealActive();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [revealActive, hasTabs]);

  // A real (non-passive) listener, scoped to the row: only it can stop the wheel from also scrolling the page, and
  // from scrolling twice (the browser's own sideways scroll plus ours) on Shift+wheel or a trackpad swipe.
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !overflows(element.scrollWidth, element.clientWidth)) return;
      const distance = wheelDistance(event, element.clientWidth);
      if (distance === 0) return;
      event.preventDefault();
      element.scrollLeft += distance;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
    };
  }, [hasTabs]);

  if (!hasTabs) {
    return <div className="tab-bar" ref={row} />;
  }

  return (
    <div className="tab-bar" role="tablist" ref={row}>
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const className = [
          "tab",
          active ? "tab--active" : "",
          tab.dirty ? "tab--dirty" : "",
          tab.preview ? "tab--preview" : "",
          tab.external === "deleted" ? "tab--deleted" : "",
          tab.external === "changed" ? "tab--conflict" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={tab.id}
            ref={(element) => {
              if (element) tabElements.current.set(tab.id, element);
              else tabElements.current.delete(tab.id);
            }}
            role="tab"
            aria-selected={active}
            className={className}
            title={tabTitle(tab)}
            draggable={onDetach !== undefined}
            onDragStart={(event) => {
              event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={(event) => {
              // Nothing inside the window took it, and it was let go outside the window.
              const outside = droppedOutside(
                { x: event.clientX, y: event.clientY },
                { width: window.innerWidth, height: window.innerHeight },
              );
              if (event.dataTransfer.dropEffect === "none" && outside) {
                onDetach?.(tab.id, { x: event.screenX, y: event.screenY });
              }
            }}
            onMouseDown={(event) => {
              if (event.button === 0) onSelect(tab.id);
            }}
            onDoubleClick={() => {
              if (tab.preview) onKeepOpen(tab.id);
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
          >
            <FileTypeIcon name={tab.kind === "markdownPreview" ? "preview.md" : tab.title} />
            <span className="tab__label">{tab.title}</span>
            <button
              type="button"
              className="tab__close"
              aria-label={t("tabs.closeNamed", { name: tab.title })}
              title={t("tabs.closeTitle")}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
      <div className="tab-bar__filler" />
    </div>
  );
}
