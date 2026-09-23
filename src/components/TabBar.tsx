import type { DocumentSnapshot } from "../services/documentService";

interface TabBarProps {
  tabs: DocumentSnapshot[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function TabBar({ tabs, activeId, onSelect, onClose }: TabBarProps) {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          className={tab.id === activeId ? "tab-bar__tab tab-bar__tab--active" : "tab-bar__tab"}
          onClick={() => {
            onSelect(tab.id);
          }}
        >
          <span className="tab-bar__title">
            {tab.dirty ? <span aria-hidden="true">&#9679; </span> : null}
            {tab.title}
          </span>
          <button
            type="button"
            className="tab-bar__close"
            aria-label={`Close ${tab.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
