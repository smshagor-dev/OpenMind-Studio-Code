import { droppedOutside } from "../services/editorWindowService";
import type { EditorTabView } from "../services/workspaceService";
import { FileTypeIcon } from "./fileIcons";
import { CloseIcon } from "./icons";

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
 * or double-clicked. Middle-click closes; the wheel scrolls horizontally.
 */
export function TabBar({ tabs, activeId, onSelect, onClose, onKeepOpen, onDetach }: TabBarProps) {
  if (tabs.length === 0) {
    return <div className="tab-bar" />;
  }

  return (
    <div
      className="tab-bar"
      role="tablist"
      onWheel={(event) => {
        if (event.deltaY !== 0) event.currentTarget.scrollLeft += event.deltaY;
      }}
    >
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
              aria-label={`Close ${tab.title}`}
              title="Close (Ctrl+W)"
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
