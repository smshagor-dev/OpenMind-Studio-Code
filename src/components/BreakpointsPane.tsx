import { useState, useSyncExternalStore } from "react";

import { breakpointSummary, type Breakpoint } from "../services/breakpointService";
import { container } from "../services/container";
import { t } from "../i18n";

/** What the running debugger can't do with these fields, or null (nothing running: unknown yet). */
function unsupportedNote(): string | null {
  const abilities = container.debug.getState().run?.capabilities;
  if (!abilities) return null;
  const missing = [
    abilities.conditionalBreakpoints ? null : t("breakpoints.conditions"),
    abilities.hitConditionalBreakpoints ? null : t("breakpoints.hitCounts"),
    abilities.logPoints ? null : t("breakpoints.logpoints"),
  ].filter((item): item is string => item !== null);
  return missing.length === 0
    ? null
    : t("breakpoints.unsupported", { what: missing.join(", ") });
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
      aria-label={t("breakpoints.editLine", { line: bp.line })}
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
        {t("breakpoints.condition")}
        <input
          autoFocus
          value={condition}
          placeholder={t("breakpoints.conditionPlaceholder")}
          onChange={(event) => {
            setCondition(event.target.value);
          }}
        />
      </label>
      <label>
        {t("breakpoints.hitCount")}
        <input
          value={hitCondition}
          placeholder={t("breakpoints.hitPlaceholder")}
          onChange={(event) => {
            setHitCondition(event.target.value);
          }}
        />
      </label>
      <label>
        {t("breakpoints.logMessage")}
        <input
          value={logMessage}
          placeholder={t("breakpoints.logPlaceholder")}
          onChange={(event) => {
            setLogMessage(event.target.value);
          }}
        />
      </label>
      {note ? <p className="debug-reason">{note}</p> : null}
      <div className="debug-bp-edit__buttons">
        <button type="submit">{t("common.save")}</button>
        <button type="button" onClick={close}>
          {t("common.cancel")}
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
          aria-label={t("breakpoints.enableAt", { where })}
          checked={bp.enabled && !bp.stale}
          disabled={bp.stale}
          onChange={(event) => {
            container.breakpoints.setEnabled(bp.id, event.target.checked);
          }}
        />
        <button
          type="button"
          className="debug-bp-row__where"
          title={bp.stale ? t("breakpoints.fileGone", { path: bp.path }) : bp.path}
          disabled={bp.stale}
          onClick={() => {
            void container.workspace.openPathAt(bp.path, { line: bp.line, column: 1, length: 0 });
          }}
        >
          {bp.logMessage !== null ? "◆ " : ""}
          {file}
          <span className="debug-bp-row__line">:{bp.line}</span>
          {bp.stale ? <span className="debug-bp-row__stale"> {t("breakpoints.fileMissing")}</span> : null}
        </button>
        <button
          type="button"
          className="debug-x"
          aria-label={t("breakpoints.editAt", { where })}
          title={t("breakpoints.editTitle")}
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
          aria-label={t("breakpoints.removeAt", { where })}
          title={t("breakpoints.remove")}
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
        {t("breakpoints.none")}
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
          {t("breakpoints.enableAll")}
        </button>
        <button
          type="button"
          onClick={() => {
            container.breakpoints.setAllEnabled(false);
          }}
        >
          {t("breakpoints.disableAll")}
        </button>
        <button
          type="button"
          onClick={() => {
            container.breakpoints.removeAll();
          }}
        >
          {t("breakpoints.removeAll")}
        </button>
      </div>
      <ul className="debug-list" aria-label={t("debug.pane.breakpoints")}>
        {list.map((bp) => (
          <Row key={bp.id} bp={bp} editing={state.editing === bp.id} />
        ))}
      </ul>
    </div>
  );
}
