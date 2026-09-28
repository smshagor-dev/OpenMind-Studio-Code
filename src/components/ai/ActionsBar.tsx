import { useState, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import { AI_ACTION_COMMANDS } from "../../services/ai/aiActionsService";
import type { AiActionKind } from "../../services/ai/aiContext";
import { useChat, useProviders } from "./aiHooks";
import { t } from "../../i18n";

const ACTION_ORDER: AiActionKind[] = ["explain", "fix", "docs", "terminal", "preview"];

/** One button per AI action; a disabled one says why in its tooltip. */
export function ActionsBar() {
  useProviders();
  useChat();
  // The selection and the active tab decide which actions can run; the terminal's selection can't be
  // watched, so the bar re-reads it when the pointer or focus arrives.
  useSyncExternalStore(
    (listener) => container.editor.subscribe(listener),
    () => container.editor.getStatus(),
  );
  useSyncExternalStore(
    (listener) => container.workspace.subscribe(listener),
    () => container.workspace.getState(),
  );
  const [, setTick] = useState(0);
  const refresh = () => {
    setTick((tick) => tick + 1);
  };
  return (
    <div
      className="ai-actions"
      role="group"
      aria-label={t("ai.actions")}
      onMouseEnter={refresh}
      onFocus={refresh}
    >
      {ACTION_ORDER.map((kind) => {
        const reason = container.ai.actions.reason(kind);
        return (
          <button
            key={kind}
            type="button"
            className="ai-action"
            disabled={reason !== null}
            title={reason ?? t(`ai.action.${kind}`)}
            onClick={() => {
              container.run(AI_ACTION_COMMANDS[kind]);
            }}
          >
            {t(`ai.action.${kind}`)}
          </button>
        );
      })}
    </div>
  );
}
