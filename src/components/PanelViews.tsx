import { useEffect, useRef, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { ProblemSeverity } from "../services/markerService";
import { ErrorIcon, WarningIcon } from "./icons";

/** Output tab: the selected channel's lines, newest at the bottom, following the tail. */
export function OutputPanel() {
  const state = useSyncExternalStore(
    (listener) => container.output.subscribe(listener),
    () => container.output.getState(),
  );
  const lines = useSyncExternalStore(
    (listener) => container.output.subscribe(listener),
    () => container.output.getLines(state.selected),
  );
  const bodyRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [lines]);

  return (
    <div className="panel-view" role="tabpanel" aria-label="Output">
      {lines.length === 0 ? (
        <p className="panel-view__empty">No output in “{state.selected}” yet.</p>
      ) : (
        <pre className="output-lines" ref={bodyRef} aria-label={`${state.selected} output`}>
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}

/** The channel picker and Clear button that sit in the panel header while Output is showing. */
export function OutputActions() {
  const state = useSyncExternalStore(
    (listener) => container.output.subscribe(listener),
    () => container.output.getState(),
  );
  const lineCount = useSyncExternalStore(
    (listener) => container.output.subscribe(listener),
    () => container.output.getLines(state.selected).length,
  );
  return (
    <>
      <select
        className="panel-select"
        aria-label="Output channel"
        value={state.selected}
        onChange={(event) => {
          container.output.select(event.target.value);
        }}
      >
        {state.channels.map((channel) => (
          <option key={channel} value={channel}>
            {channel}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="terminal-panel__action"
        title="Clear Output"
        aria-label="Clear Output"
        disabled={lineCount === 0}
        onClick={() => {
          container.run("output.clear");
        }}
      >
        ⌫
      </button>
    </>
  );
}

const SEVERITY_LABEL: Record<ProblemSeverity, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
  hint: "Hint",
};

/** Problems tab: what Monaco's markers report for each open file, or an honest "no problems". */
export function ProblemsPanel() {
  const files = useSyncExternalStore(
    (listener) => container.markers.subscribe(listener),
    () => container.markers.getProblemFiles(),
  );
  if (files.length === 0) {
    return (
      <div className="panel-view" role="tabpanel" aria-label="Problems">
        <p className="panel-view__empty">No problems have been detected in the workspace.</p>
      </div>
    );
  }
  return (
    <div className="panel-view" role="tabpanel" aria-label="Problems">
      <ul className="problems">
        {files.map((file) => (
          <li key={file.uri} className="problems__file">
            <div className="problems__file-name" title={file.path ?? file.title}>
              {file.title}
              <span className="problems__count">{file.problems.length}</span>
            </div>
            <ul>
              {file.problems.map((problem, index) => (
                <li key={`${String(problem.line)}:${String(problem.column)}:${String(index)}`}>
                  <button
                    type="button"
                    className="problems__item"
                    onClick={() => {
                      container.workspace.openProblemAt(file.uri, {
                        line: problem.line,
                        column: problem.column,
                        length: Math.max(1, problem.endColumn - problem.column),
                      });
                    }}
                  >
                    {problem.severity === "error" ? (
                      <ErrorIcon />
                    ) : (
                      <WarningIcon className={`codicon codicon--${problem.severity}`} />
                    )}
                    <span className="problems__message">{problem.message}</span>
                    <span className="problems__where">
                      {SEVERITY_LABEL[problem.severity]} [Ln {problem.line}, Col {problem.column}]
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Debug Console tab: there is no debugger yet, and the panel says so instead of pretending. */
export function DebugConsolePanel() {
  return (
    <div className="panel-view" role="tabpanel" aria-label="Debug Console">
      <p className="panel-view__empty">
        The Debug Console isn&apos;t available yet — debugging is not supported in this version.
      </p>
    </div>
  );
}

/** Ports tab: the ports OpenMind Studio's own services have registered. */
export function PortsPanel() {
  const ports = useSyncExternalStore(
    (listener) => container.ports.subscribe(listener),
    () => container.ports.list(),
  );
  if (ports.length === 0) {
    return (
      <div className="panel-view" role="tabpanel" aria-label="Ports">
        <p className="panel-view__empty">
          No ports are registered. Local servers started by OpenMind Studio will appear here.
        </p>
      </div>
    );
  }
  return (
    <div className="panel-view" role="tabpanel" aria-label="Ports">
      <table className="ports-table">
        <thead>
          <tr>
            <th>Port</th>
            <th>Label</th>
            <th>Address</th>
            <th>Source</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {ports.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.port}</td>
              <td>{entry.label}</td>
              <td>{entry.url ?? "—"}</td>
              <td>{entry.source}</td>
              <td className="ports-table__actions">
                <button
                  type="button"
                  disabled={entry.url === null}
                  title={
                    entry.url === null
                      ? "This port has no web address to open."
                      : `Open ${entry.url}`
                  }
                  onClick={() => {
                    void container.ports.openInBrowser(entry.id);
                  }}
                >
                  Open in Browser
                </button>
                <button
                  type="button"
                  title="Remove this port from the list"
                  onClick={() => {
                    container.ports.unregister(entry.id);
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
