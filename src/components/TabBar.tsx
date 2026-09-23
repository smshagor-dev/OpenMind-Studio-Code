import type { DocumentSnapshot } from "../services/documentService";
import { FileTypeIcon } from "./fileIcons";
import { CloseIcon } from "./icons";

interface TabBarProps {
  tabs: DocumentSnapshot[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * VS Code editor tabs: file-type icon, name, and a close button that shows
 * on the active/hovered tab — or a dot while the file is dirty, turning back
 * into × on hover. Middle-click closes; the wheel scrolls horizontally.
 */
export function TabBar({ tabs, activeId, onSelect, onClose }: TabBarProps) {
  if (tabs.length === 0) {
    return null;
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
        const className = ["tab", active ? "tab--active" : "", tab.dirty ? "tab--dirty" : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={className}
            title={tab.path ?? tab.title}
            onMouseDown={(event) => {
              if (event.button === 0) onSelect(tab.id);
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
          >
            <FileTypeIcon name={tab.title} />
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
