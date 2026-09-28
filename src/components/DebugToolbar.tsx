import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { DebugControl } from "../services/debugModel";
import "../styles/debug.css";
import { withShortcut } from "./shortcutLabel";
import { t } from "../i18n";

interface ToolButton {
  id: string;
  label: string;
  glyph: string;
  control: DebugControl | "stop" | "restart";
}

const BUTTONS: ToolButton[] = [
  { id: "debug.continue", label: "debug.toolbar.continue", glyph: "▶", control: "continue" },
  { id: "debug.pause", label: "debug.toolbar.pause", glyph: "⏸", control: "pause" },
  { id: "debug.stepOver", label: "debug.toolbar.stepOver", glyph: "⤼", control: "stepOver" },
  { id: "debug.stepInto", label: "debug.toolbar.stepInto", glyph: "↓", control: "stepInto" },
  { id: "debug.stepOut", label: "debug.toolbar.stepOut", glyph: "↑", control: "stepOut" },
  { id: "debug.restart", label: "debug.toolbar.restart", glyph: "⟳", control: "restart" },
  { id: "debug.stop", label: "debug.toolbar.stop", glyph: "■", control: "stop" },
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
    <div className="debug-toolbar" role="toolbar" aria-label={t("debug.toolbar")}>
      {BUTTONS.map((button) => {
        const state = debug.controlState(button.control);
        const title = state.enabled
          ? withShortcut(t(button.label), button.id)
          : `${t(button.label)} — ${state.reason ?? ""}`;
        return (
          <button
            key={button.id}
            type="button"
            className={`debug-toolbar__button debug-toolbar__button--${button.control}`}
            aria-label={t(button.label)}
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
