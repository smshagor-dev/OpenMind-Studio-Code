import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import "../styles/debug.css";
import { shortcutFor } from "./shortcutLabel";
import { t } from "../i18n";

/** The Debug Console tab: the program's output, adapter messages, and an evaluate prompt. */
export function DebugConsoleView() {
  const state = useSyncExternalStore(
    (listener) => container.debugConsole.subscribe(listener),
    () => container.debugConsole.getState(),
  );
  useSyncExternalStore(
    (listener) => container.debug.subscribe(listener),
    () => container.debug.getState(),
  );
  const [draft, setDraft] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [state.lines]);
  const reason = container.debug.evaluateUnavailable();

  return (
    <div className="panel-view debug-console" role="tabpanel" aria-label={t("debugConsole.title")}>
      <div className="debug-console__bar">
        <button
          type="button"
          disabled={state.lines.length === 0}
          onClick={() => {
            container.debugConsole.clear();
          }}
        >
          {t("debugConsole.clear")}
        </button>
      </div>
      <div className="debug-console__lines" ref={bodyRef} aria-label={t("debugConsole.output")}>
        {state.lines.length === 0 ? (
          <p className="panel-view__empty">
            {t("debugConsole.empty", { how: shortcutFor("debug.start") ?? t("debugConsole.theRunMenu") })}
          </p>
        ) : (
          state.lines.map((line) => (
            <div key={line.id} className={`debug-console__line debug-console__line--${line.kind}`}>
              {line.text}
            </div>
          ))
        )}
      </div>
      <form
        className="debug-console__input"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft;
          setDraft("");
          void container.debugConsole.evaluate(text);
        }}
      >
        <input
          aria-label={t("debugConsole.evaluate")}
          placeholder={reason ?? t("debugConsole.evaluatePlaceholder")}
          title={reason ?? undefined}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
      </form>
    </div>
  );
}
