import { useRef, useState } from "react";

import { container } from "../services/container";

interface SashProps {
  /** Which edge of the side bar the sash sits on (opposite the side bar's own side). */
  side: "left" | "right";
}

/**
 * The draggable edge that resizes the side bar, as in VS Code: live width
 * while dragging, persisted once on release; double-click restores the
 * default width.
 */
export function Sash({ side }: SashProps) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });

  return (
    <div
      className={[
        "sash",
        side === "left" ? "sash--left" : "sash--right",
        dragging ? "sash--active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side bar"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width: event.currentTarget.closest(".sidebar")?.getBoundingClientRect().width ?? container.layout.getState().sidebarWidth };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        const delta = event.clientX - start.current.x;
        container.layout.previewSidebarWidth(
          start.current.width + (side === "right" ? delta : -delta),
        );
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        void container.layout.commitSidebarWidth();
      }}
      onDoubleClick={() => {
        container.layout.previewSidebarWidth(260);
        void container.layout.commitSidebarWidth();
      }}
    />
  );
}
