import { useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { ScopeNode, VariableNode } from "../services/variablesService";
import { t } from "../i18n";

/** Variables, Watch, Call Stack and Breakpoints — UI only; the services own the state. */

function VariableRow({ node, depth }: { node: VariableNode; depth: number }) {
  const expandable = node.variable.variablesReference !== 0;
  return (
    <>
      <li className="debug-var" style={{ paddingLeft: 8 + depth * 12 }}>
        {expandable ? (
          <button
            type="button"
            className="debug-var__twist"
            aria-label={t(node.expanded ? "debug.collapseNamed" : "debug.expandNamed", { name: node.variable.name })}
            aria-expanded={node.expanded}
            onClick={() => {
              void container.variables.toggleVariable(node.key);
            }}
          >
            {node.expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="debug-var__twist" />
        )}
        <span className="debug-var__name">{node.variable.name}</span>
        <span className="debug-var__value" title={node.variable.type ?? undefined}>
          {node.variable.value}
        </span>
      </li>
      {node.expanded && node.loading ? (
        <li className="debug-empty" style={{ paddingLeft: 20 + depth * 12 }}>
          {t("common.loading")}
        </li>
      ) : null}
      {node.expanded
        ? (node.children ?? []).map((child) => (
            <VariableRow key={child.key} node={child} depth={depth + 1} />
          ))
        : null}
    </>
  );
}

function ScopeBlock({ scope }: { scope: ScopeNode }) {
  return (
    <li className="debug-scope">
      <button
        type="button"
        className="debug-scope__header"
        aria-expanded={scope.expanded}
        onClick={() => {
          void container.variables.toggleScope(scope.key);
        }}
      >
        {scope.expanded ? "▾" : "▸"} {scope.scope.name}
      </button>
      {scope.expanded ? (
        <ul className="debug-list">
          {scope.loading ? <li className="debug-empty">Loading…</li> : null}
          {(scope.variables ?? []).map((node) => (
            <VariableRow key={node.key} node={node} depth={0} />
          ))}
          {!scope.loading && scope.variables?.length === 0 ? (
            <li className="debug-empty">No variables in this scope.</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function VariablesPane() {
  const state = useSyncExternalStore(
    (listener) => container.variables.subscribe(listener),
    () => container.variables.getState(),
  );
  if (state.scopes.length === 0) {
    return <p className="debug-empty">{t("debug.variablesWhenPaused")}</p>;
  }
  return (
    <ul className="debug-list" aria-label={t("debug.pane.variables")}>
      {state.scopes.map((scope) => (
        <ScopeBlock key={scope.key} scope={scope} />
      ))}
    </ul>
  );
}

export function WatchPane() {
  const state = useSyncExternalStore(
    (listener) => container.watches.subscribe(listener),
    () => container.watches.getState(),
  );
  const [draft, setDraft] = useState("");
  return (
    <div>
      <form
        className="debug-add"
        onSubmit={(event) => {
          event.preventDefault();
          container.watches.add(draft);
          setDraft("");
        }}
      >
        <input
          aria-label={t("debug.addWatch")}
          placeholder={t("debug.addExpression")}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
      </form>
      {state.entries.length === 0 ? (
        <p className="debug-empty">{t("debug.noWatches")}</p>
      ) : (
        <ul className="debug-list" aria-label={t("debug.pane.watch")}>
          {state.entries.map((entry) => (
            <li key={entry.id} className="debug-var">
              <span className="debug-var__name">{entry.expression}</span>
              <span
                className={
                  entry.error ? "debug-var__value debug-var__value--error" : "debug-var__value"
                }
              >
                {entry.error ?? entry.value ?? t("debug.notAvailable")}
              </span>
              <button
                type="button"
                className="debug-x"
                aria-label={t("debug.removeWatch", { expression: entry.expression })}
                title={t("keys.remove")}
                onClick={() => {
                  container.watches.remove(entry.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CallStackPane() {
  const state = useSyncExternalStore(
    (listener) => container.callStack.subscribe(listener),
    () => container.callStack.getState(),
  );
  if (state.frames.length === 0) {
    return <p className="debug-empty">{t("debug.stackWhenPaused")}</p>;
  }
  return (
    <ul className="debug-list" aria-label={t("debug.pane.callStack")}>
      {state.frames.map((frame) => {
        const file = frame.path?.split(/[\\/]/).pop() ?? null;
        return (
          <li key={frame.id}>
            <button
              type="button"
              className={
                frame.id === state.selectedId
                  ? "debug-frame debug-frame--selected"
                  : frame.hint === "deemphasize" || frame.hint === "subtle"
                    ? "debug-frame debug-frame--dim"
                    : "debug-frame"
              }
              title={frame.path ?? t("debug.noFileFrame")}
              onClick={() => {
                container.callStack.select(frame);
              }}
            >
              <span className="debug-frame__name">{frame.name}</span>
              {file ? (
                <span className="debug-frame__where">
                  {file}:{frame.line}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export { BreakpointsPane } from "./BreakpointsPane";
