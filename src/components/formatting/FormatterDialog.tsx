import { useEffect, useSyncExternalStore } from "react";

import { container } from "../../services/container";
import {
  type DialogMode,
  type FormatterChoice,
  sourceLabel,
} from "../../services/formatting/formattingService";
import "../../styles/formatting.css";

const TITLES: Record<DialogMode, string> = {
  with: "Format Document With...",
  configure: "Configure Default Formatter",
  status: "Formatter Status",
};

function Row({
  choice,
  mode,
  selectedId,
}: {
  choice: FormatterChoice;
  mode: DialogMode;
  selectedId: string | null;
}) {
  return (
    <li className="formatter__row">
      <div className="formatter__what">
        <span className="formatter__name">
          {choice.name}
          {choice.id === selectedId ? <span className="formatter__chip">In use</span> : null}
        </span>
        <span className="formatter__source" title={choice.path ?? undefined}>
          {choice.available ? sourceLabel(choice.source) : (choice.reason ?? "Not available")}
        </span>
      </div>
      {mode === "status" ? null : (
        <button
          type="button"
          disabled={!choice.available}
          title={choice.available ? undefined : (choice.reason ?? undefined)}
          onClick={() => {
            void container.formatting.pick(choice.id);
          }}
        >
          {mode === "with" ? "Format" : "Use"}
        </button>
      )}
    </li>
  );
}

/** Lists the formatters that could apply to the file in front, each with its source or the reason it can't be used. */
export function FormatterDialog() {
  const { dialog } = useSyncExternalStore(
    container.formatting.subscribe,
    container.formatting.getState,
  );
  const open = dialog !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") container.formatting.closeDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (dialog === null) return null;
  const { status, mode, remember } = dialog;
  return (
    <div
      className="modal-overlay"
      onClick={() => {
        container.formatting.closeDialog();
      }}
    >
      <div
        className="modal modal--formatter"
        role="dialog"
        aria-modal="true"
        aria-labelledby="formatter-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="formatter-title">{TITLES[mode]}</h2>
        <p className="formatter__lead">
          {status.languageName}
          {status.selected ? ` — in use: ${status.selected.name}` : " — no formatter is available."}
        </p>
        {status.selected === null && status.reason ? (
          <p className="formatter__reason">{status.reason}</p>
        ) : null}
        {status.choices.length === 0 ? (
          <p className="formatter__reason">
            No formatter is known for this file type. Nothing is installed or downloaded
            automatically.
          </p>
        ) : (
          <ul className="formatter__list" aria-label="Formatters">
            {status.choices.map((choice) => (
              <Row
                key={choice.id}
                choice={choice}
                mode={mode}
                selectedId={status.selected?.id ?? null}
              />
            ))}
          </ul>
        )}
        {mode === "with" && status.choices.some((choice) => choice.available) ? (
          <label className="formatter__remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => {
                container.formatting.setRemember(event.target.checked);
              }}
            />
            Remember as the default formatter for {status.languageName}
          </label>
        ) : null}
        <div className="modal__actions">
          {mode === "status" ? (
            <button
              type="button"
              onClick={() => {
                void container.formatting.openDialog("configure");
              }}
            >
              Configure Default...
            </button>
          ) : null}
          <button
            type="button"
            className="modal__confirm--primary"
            onClick={() => {
              container.formatting.closeDialog();
            }}
            autoFocus
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
