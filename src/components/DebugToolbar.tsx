import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { DebugControl } from "../services/debugModel";
import "../styles/debug.css";

interface ToolButton {
  id: string;
  label: string;
  shortcut: string;
  glyph: string;
  control: DebugControl | "stop" | "restart";
}

const BUTTONS: ToolButton[] = [
  { id: "debug.continue", label: "Continue", shortcut: "F5", glyph: "▶", control: "continue" },
  { id: "debug.pause", label: "Pause", shortcut: "", glyph: "⏸", control: "pause" },
  { id: "debug.stepOver", label: "Step Over", shortcut: "F10", glyph: "⤼", control: "stepOver" },
  { id: "debug.stepInto", label: "Step Into", shortcut: "F11", glyph: "↓", control: "stepInto" },
  { id: "debug.stepOut", label: "Step Out", shortcut: "Shift+F11", glyph: "↑", control: "stepOut" },
  { id: "debug.restart", label: "Restart", shortcut: "", glyph: "⟳", control: "restart" },
  { id: "debug.stop", label: "Stop", shortcut: "Shift+F5", glyph: "■", control: "stop" },
];

/** The floating debug toolbar, shown while a session exists. Each button is a real command, disabled with its reason. */
export function DebugToolbar() {
  useSyncExternalStore(
    (listener) => container.debug.subscribe(listener),
    () => container.debug.getState(),
  );
  const debug = container.debug;
  if (!debug.isDebugging()) return null;
  return (
    <div className="debug-toolbar" role="toolbar" aria-label="Debug">
      {BUTTONS.map((button) => {
        const state = debug.controlState(button.control);
        const title = state.enabled
          ? `${button.label}${button.shortcut ? ` (${button.shortcut})` : ""}`
          : `${button.label} — ${state.reason ?? ""}`;
        return (
          <button
            key={button.id}
            type="button"
            className={`debug-toolbar__button debug-toolbar__button--${button.control}`}
            aria-label={button.label}
            title={title}
            disabled={!state.enabled}
            onClick={() => {
              container.run(button.id);
            }}
          >
            {button.glyph}
          </button>
        );
      })}
    </div>
  );
}
