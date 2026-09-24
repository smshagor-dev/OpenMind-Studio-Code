import { useEffect, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { LspServerInfo } from "../services/ipc";

const STATE_LABEL: Record<LspServerInfo["state"], string> = {
  running: "Running",
  starting: "Starting…",
  stopped: "Stopped",
  installing: "Installing…",
  error: "Error",
};

/**
 * Manage > Language Tools: every language server, whether it is installed and
 * running, and the actions that really work for it (install from a pinned
 * lockfile, restart, stop, open its log). Nothing here downloads on its own.
 */
export function LanguageToolsDialog({ onClose }: { onClose: () => void }) {
  const state = useSyncExternalStore(
    (listener) => container.lsp.subscribe(listener),
    () => container.lsp.getState(),
  );
  useEffect(() => {
    void container.lsp.refresh();
  }, []);
  const snapshot = state.snapshot;

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        className="modal modal--runtimes"
        role="dialog"
        aria-modal="true"
        aria-labelledby="language-tools-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="language-tools-title">Language Tools</h2>
        <p className="runtimes__intro">
          Language servers give the editor completion, hover, diagnostics, go to definition, rename
          and formatting. They run on Node.js, only for files inside the open folder, and are
          installed only when you press Install.
        </p>
        {snapshot === null ? <p className="runtimes__loading">Loading…</p> : null}
        {snapshot?.node ? (
          <p className="runtime-card__notes" data-testid="lsp-node">
            Node.js: {snapshot.node}
          </p>
        ) : null}
        {snapshot?.nodeProblem ? (
          <p className="runtime-card__notes lsp-problem" role="status">
            {snapshot.nodeProblem} Install Node.js from the Runtime Manager to install or run
            language servers.
          </p>
        ) : null}
        {snapshot !== null && snapshot.workspace === null ? (
          <p className="runtime-card__notes">Open a folder to start language servers.</p>
        ) : null}
        <div className="runtimes__list">
          {snapshot?.servers.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
        <div className="lsp-footer">
          <label>
            <input
              type="checkbox"
              checked={snapshot?.verbose ?? false}
              onChange={(event) => {
                void container.lsp.setVerbose(event.target.checked);
              }}
            />{" "}
            Verbose logging (protocol chatter in the LSP output)
          </label>
          <button
            type="button"
            onClick={() => {
              container.run("lsp.openOutput");
              onClose();
            }}
          >
            Open LSP Output
          </button>
        </div>
        <div className="modal__actions">
          <button type="button" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ServerCard({ server }: { server: LspServerInfo }) {
  const lsp = container.lsp;
  const busy = server.state === "installing" || server.state === "starting";
  const installLabel = server.state === "installing" ? "Installing…" : "Install";
  return (
    <section className="runtime-card" aria-label={server.name}>
      <header className="runtime-card__header">
        <h3>{server.name}</h3>
        <span
          className={server.installed ? "runtime-badge runtime-badge--installed" : "runtime-badge"}
        >
          {server.installed ? "Installed" : "Missing"}
        </span>
        <span
          className={
            server.state === "error"
              ? "runtime-badge runtime-badge--warn"
              : server.state === "running"
                ? "runtime-badge runtime-badge--active"
                : "runtime-badge"
          }
        >
          {STATE_LABEL[server.state]}
        </span>
      </header>
      <p className="runtime-card__description">Languages: {server.languages.join(", ")}</p>
      {!server.installed ? (
        <p className="runtime-card__notes">Language server is not installed yet.</p>
      ) : null}
      {server.state === "error" && server.message ? (
        <p className="runtime-card__notes lsp-problem">{server.message}</p>
      ) : null}
      {server.state === "running" ? (
        <p className="runtime-card__notes">
          pid {server.pid ?? "?"} · {server.openDocuments} open file
          {server.openDocuments === 1 ? "" : "s"} · {server.node}
        </p>
      ) : null}
      {server.note ? <p className="runtime-card__notes">{server.note}</p> : null}
      {!server.installed ? (
        <p className="runtime-card__notes">Installs: {server.contents}</p>
      ) : null}
      {!server.installed && server.installBlocked ? (
        <p className="runtime-card__notes lsp-problem">{server.installBlocked}</p>
      ) : null}
      <div className="runtime-card__install">
        {!server.installed ? (
          <button
            type="button"
            className="button button--primary"
            disabled={!server.canInstall || busy}
            title={server.installBlocked ?? `Download and install ${server.contents}`}
            onClick={() => {
              void lsp.install(server.id);
            }}
          >
            {installLabel}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!server.installed || busy}
          title={
            server.installed
              ? "Stop the server and start it again for the open files"
              : "Language server is not installed yet."
          }
          onClick={() => {
            void lsp.restart(server.id);
          }}
        >
          Restart
        </button>
        <button
          type="button"
          disabled={server.state !== "running"}
          title={
            server.state === "running" ? "Stop the server" : "The language server isn't running."
          }
          onClick={() => {
            void lsp.stop(server.id);
          }}
        >
          Stop
        </button>
        <button
          type="button"
          disabled={!server.logExists}
          title={server.logExists ? "Open the server's log file" : "There is no log yet."}
          onClick={() => {
            void lsp.openLog(server.id);
          }}
        >
          Open Logs
        </button>
      </div>
    </section>
  );
}
