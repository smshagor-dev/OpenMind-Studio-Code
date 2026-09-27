import { useState, useSyncExternalStore } from "react";

import { breakpointSummary, type Breakpoint } from "../services/breakpointService";
import { container } from "../services/container";

/** What the running debugger can't do with these fields, or null (nothing running: unknown yet). */
function unsupportedNote(): string | null {
  const abilities = container.debug.getState().run?.capabilities;
  if (!abilities) return null;
  const missing = [
    abilities.conditionalBreakpoints ? null : "conditions",
    abilities.hitConditionalBreakpoints ? null : "hit counts",
    abilities.logPoints ? null : "logpoints",
  ].filter((item): item is string => item !== null);
  return missing.length === 0
    ? null
    : `The running debugger doesn't support breakpoint ${missing.join(", ")}.`;
}

function EditForm({ bp }: { bp: Breakpoint }) {
  const [condition, setCondition] = useState(bp.condition ?? "");
  const [hitCondition, setHitCondition] = useState(bp.hitCondition ?? "");
  const [logMessage, setLogMessage] = useState(bp.logMessage ?? "");
  const note = unsupportedNote();
  const close = () => {
    container.breakpoints.stopEditing();
  };
  return (
    <form
      className="debug-bp-edit"
      aria-label={`Edit breakpoint line ${String(bp.line)}`}
      onSubmit={(event) => {
        event.preventDefault();
        container.breakpoints.setOptions(bp.id, { condition, hitCondition, logMessage });
        close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <label>
        Condition
        <input
          autoFocus
          value={condition}
          placeholder="Stop only when this is true, e.g. x > 3"
          onChange={(event) => {
            setCondition(event.target.value);
          }}
        />
      </label>
      <label>
        Hit count
        <input
          value={hitCondition}
          placeholder="Stop on this hit, e.g. 5 or >= 5"
          onChange={(event) => {
            setHitCondition(event.target.value);
          }}
        />
      </label>
      <label>
        Log message
        <input
          value={logMessage}
          placeholder="Print this instead of stopping, e.g. x is {x}"
          onChange={(event) => {
            setLogMessage(event.target.value);
          }}
        />
      </label>
      {note ? <p className="debug-reason">{note}</p> : null}
      <div className="debug-bp-edit__buttons">
        <button type="submit">Save</button>
        <button type="button" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Row({ bp, editing }: { bp: Breakpoint; editing: boolean }) {
  const file = bp.path.split(/[\\/]/).pop() ?? bp.path;
  const summary = breakpointSummary(bp);
  const where = `${file}:${String(bp.line)}`;
  return (
    <li className={bp.stale ? "debug-bp-row debug-bp-row--stale" : "debug-bp-row"}>
      <div className="debug-bp-row__main">
        <input
          type="checkbox"
          aria-label={`Enable breakpoint ${where}`}
          checked={bp.enabled && !bp.stale}
          disabled={bp.stale}
          onChange={(event) => {
            container.breakpoints.setEnabled(bp.id, event.target.checked);
          }}
        />
        <button
          type="button"
          className="debug-bp-row__where"
          title={bp.stale ? `${bp.path} — the file no longer exists` : bp.path}
          disabled={bp.stale}
          onClick={() => {
            void container.workspace.openPathAt(bp.path, { line: bp.line, column: 1, length: 0 });
          }}
        >
          {bp.logMessage !== null ? "◆ " : ""}
          {file}
          <span className="debug-bp-row__line">:{bp.line}</span>
          {bp.stale ? <span className="debug-bp-row__stale"> (file missing)</span> : null}
        </button>
        <button
          type="button"
          className="debug-x"
          aria-label={`Edit breakpoint ${where}`}
          title="Condition, hit count or log message"
          disabled={bp.stale}
          onClick={() => {
            container.breakpoints.startEditing(bp.id);
          }}
        >
          ✎
        </button>
        <button
          type="button"
          className="debug-x"
          aria-label={`Remove breakpoint ${where}`}
          title="Remove breakpoint"
          onClick={() => {
            container.breakpoints.remove(bp.id);
          }}
        >
          ×
        </button>
      </div>
      {summary !== "" && !editing ? <p className="debug-bp-row__extra">{summary}</p> : null}
      {editing ? <EditForm bp={bp} /> : null}
    </li>
  );
}

/** The breakpoint list: enable/disable, jump to, edit (condition, hit count, logpoint), remove. */
export function BreakpointsPane() {
  const state = useSyncExternalStore(
    (listener) => container.breakpoints.subscribe(listener),
    () => container.breakpoints.getState(),
  );
  useSyncExternalStore(
    (listener) => container.debug.subscribe(listener),
    () => container.debug.getState(),
  );
  const list = state.breakpoints;
  if (list.length === 0) {
    return (
      <p className="debug-empty">
        No breakpoints. Click the gutter beside a line number to add one.
      </p>
    );
  }
  return (
    <div>
      <div className="debug-bp-actions">
        <button
          type="button"
          onClick={() => {
            container.breakpoints.setAllEnabled(true);
          }}
        >
          Enable All
        </button>
        <button
          type="button"
          onClick={() => {
            container.breakpoints.setAllEnabled(false);
          }}
        >
          Disable All
        </button>
        <button
          type="button"
          onClick={() => {
            container.breakpoints.removeAll();
          }}
        >
          Remove All
        </button>
      </div>
      <ul className="debug-list" aria-label="Breakpoints">
        {list.map((bp) => (
          <Row key={bp.id} bp={bp} editing={state.editing === bp.id} />
        ))}
      </ul>
    </div>
  );
}
