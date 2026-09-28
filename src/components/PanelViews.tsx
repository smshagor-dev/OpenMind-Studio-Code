import { useEffect, useRef, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { ProblemSeverity } from "../services/markerService";
import { DebugConsoleView } from "./DebugConsoleView";
import { ErrorIcon, WarningIcon } from "./icons";
import { t } from "../i18n";

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
    <div className="panel-view" role="tabpanel" aria-label={t("secondary.output")}>
      {lines.length === 0 ? (
        <p className="panel-view__empty">{t("output.empty", { channel: state.selected })}</p>
      ) : (
        <pre className="output-lines" ref={bodyRef} aria-label={t("output.of", { channel: state.selected })}>
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
        aria-label={t("output.channel")}
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
        title={t("secondary.clear")}
        aria-label={t("secondary.clear")}
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
  error: "problems.error",
  warning: "problems.warning",
  info: "problems.info",
  hint: "problems.hint",
};

/** Problems tab: what Monaco's markers report for each open file, or an honest "no problems". */
export function ProblemsPanel() {
  const files = useSyncExternalStore(
    (listener) => container.markers.subscribe(listener),
    () => container.markers.getProblemFiles(),
  );
  if (files.length === 0) {
    return (
      <div className="panel-view" role="tabpanel" aria-label={t("problems.title")}>
        <p className="panel-view__empty">{t("problems.none")}</p>
      </div>
    );
  }
  return (
    <div className="panel-view" role="tabpanel" aria-label={t("problems.title")}>
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
                      const target = {
                        line: problem.line,
                        column: problem.column,
                        length: Math.max(1, problem.endColumn - problem.column),
                      };
                      // A task's problem may be in a file that isn't open: open it by path.
                      if (!container.workspace.openProblemAt(file.uri, target) && file.path !== null) {
                        void container.workspace.openPathAt(file.path, target);
                      }
                    }}
                  >
                    {problem.severity === "error" ? (
                      <ErrorIcon />
                    ) : (
                      <WarningIcon className={`codicon codicon--${problem.severity}`} />
                    )}
                    <span className="problems__message">{problem.message}</span>
                    <span className="problems__where">
                      {t("problems.where", {
                        severity: t(SEVERITY_LABEL[problem.severity]),
                        line: problem.line,
                        column: problem.column,
                      })}
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

/** Debug Console tab: the debug session's console (see `DebugConsoleView`). */
export function DebugConsolePanel() {
  return <DebugConsoleView />;
}

/** Ports tab: the ports OpenMind Studio's own services have registered. */
export function PortsPanel() {
  const ports = useSyncExternalStore(
    (listener) => container.ports.subscribe(listener),
    () => container.ports.list(),
  );
  if (ports.length === 0) {
    return (
      <div className="panel-view" role="tabpanel" aria-label={t("panel.ports")}>
        <p className="panel-view__empty">
          {t("ports.none")}
        </p>
      </div>
    );
  }
  return (
    <div className="panel-view" role="tabpanel" aria-label={t("panel.ports")}>
      <table className="ports-table">
        <thead>
          <tr>
            <th>{t("php.col.port")}</th>
            <th>{t("ports.label")}</th>
            <th>{t("php.col.address")}</th>
            <th>{t("keys.col.source")}</th>
            <th aria-label={t("keys.col.actions")} />
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
                      ? t("ports.noAddress")
                      : t("ports.openUrl", { url: entry.url })
                  }
                  onClick={() => {
                    void container.ports.openInBrowser(entry.id);
                  }}
                >
                  {t("ports.openInBrowser")}
                </button>
                <button
                  type="button"
                  title={t("ports.removeTitle")}
                  onClick={() => {
                    container.ports.unregister(entry.id);
                  }}
                >
                  {t("keys.remove")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
