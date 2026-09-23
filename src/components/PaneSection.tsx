import type { ReactNode } from "react";

import { ChevronIcon } from "./icons";

export interface PaneAction {
  label: string;
  icon: ReactNode;
  onRun: () => void;
  disabled?: boolean;
}

interface PaneSectionProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  /** Icon buttons shown on the header's right while hovered/focused (VS Code view actions). */
  actions?: PaneAction[];
  /** Grow to fill the remaining sidebar height (the folder tree) rather than size to content. */
  grow?: boolean;
  children: ReactNode;
}

/** A collapsible sidebar section with VS Code's 22px uppercase header ("OPEN EDITORS", "<FOLDER>"). */
export function PaneSection({
  title,
  expanded,
  onToggle,
  actions,
  grow,
  children,
}: PaneSectionProps) {
  const className = [
    "pane-section",
    expanded ? "pane-section--expanded" : "",
    grow && expanded ? "pane-section--grow" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={className} aria-label={title}>
      <div
        className="pane-section__header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <ChevronIcon expanded={expanded} />
        <h3 className="pane-section__title" title={title}>
          {title}
        </h3>
        {expanded && actions && actions.length > 0 ? (
          <div className="pane-section__actions">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="pane-section__action"
                title={action.label}
                aria-label={action.label}
                disabled={action.disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  action.onRun();
                }}
              >
                {action.icon}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {expanded ? <div className="pane-section__body">{children}</div> : null}
    </section>
  );
}
