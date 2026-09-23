import { ExplorerActivityIcon } from "./icons";

interface ActivityBarProps {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
}

/** VS Code-style leftmost icon rail. Only Explorer exists so far — no placeholder icons for future panels. */
export function ActivityBar({ sidebarVisible, onToggleSidebar }: ActivityBarProps) {
  return (
    <div className="activity-bar">
      <button
        type="button"
        className={
          sidebarVisible ? "activity-bar__item activity-bar__item--active" : "activity-bar__item"
        }
        aria-label="Explorer"
        aria-pressed={sidebarVisible}
        onClick={onToggleSidebar}
      >
        <ExplorerActivityIcon />
      </button>
    </div>
  );
}
