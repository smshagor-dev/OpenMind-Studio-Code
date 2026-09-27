import { useEffect, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { LspBundleInfo, LspServerInfo } from "../services/ipc";

const STATE_LABEL: Record<LspServerInfo["state"], string> = {
  running: "Running",
  starting: "Starting…",
  stopped: "Stopped",
  installing: "Installing…",
  error: "Error",
};

/**
 * Manage > Language Tools: every language server, whether it is ready and
 * running, and the actions that really work for it (unpack from the offline
 * bundle, install from a pinned lockfile, restart, stop, open its log).
 * Nothing here downloads on its own.
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
        className="modal modal--runtimes modal--lsp-tools"
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
          and formatting. They start only for files inside the open folder. Servers in the offline
          bundle need no download; any other server is installed only when you press Install.
        </p>
        {snapshot === null ? <p className="runtimes__loading">Loading…</p> : null}
        {snapshot ? <BundleLine bundle={snapshot.bundle} /> : null}
        {snapshot?.node ? (
          <p className="runtime-card__notes" data-testid="lsp-node">
            Node.js: {snapshot.node}
          </p>
        ) : null}
        {snapshot?.nodeProblem ? (
          <p className="runtime-card__notes lsp-problem" role="status">
            {snapshot.nodeProblem} Install Node.js from the Runtime Manager to install or run the
            Node.js-based language servers.
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

function BundleLine({ bundle }: { bundle: LspBundleInfo }) {
  if (bundle.present) {
    return (
      <p className="runtime-card__notes" data-testid="lsp-bundle">
        Offline bundle: {bundle.packs} language server package{bundle.packs === 1 ? "" : "s"}
        {bundle.nodeVersion ? ` and Node.js ${bundle.nodeVersion}` : ""} ship with this copy of
        OpenMind Studio. They are unpacked the first time they are needed; nothing is downloaded.
      </p>
    );
  }
  return (
    <p className="runtime-card__notes" data-testid="lsp-bundle">
      {bundle.problem ?? "This copy has no offline language server bundle."} Servers are installed
      from npm when you press Install.
    </p>
  );
}

/** The availability badge: ready (and from where), bundled but not unpacked yet, or missing. */
function availabilityBadge(server: LspServerInfo): { text: string; ready: boolean } {
  if (server.installed) {
    return { text: server.installSource === "bundle" ? "Bundled" : "Installed", ready: true };
  }
  return server.bundled ? { text: "Bundled", ready: true } : { text: "Missing", ready: false };
}

function ServerCard({ server }: { server: LspServerInfo }) {
  const lsp = container.lsp;
  const busy = server.state === "installing" || server.state === "starting";
  const preparing = server.bundled ? "Unpacking…" : "Installing…";
  const installLabel =
    server.state === "installing" ? preparing : server.bundled ? "Unpack Now" : "Install";
  const badge = availabilityBadge(server);
  const usable = server.installed || server.bundled;
  return (
    <section className="runtime-card" aria-label={server.name}>
      <header className="runtime-card__header">
        <h3>{server.name}</h3>
        <span className={badge.ready ? "runtime-badge runtime-badge--installed" : "runtime-badge"}>
          {badge.text}
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
          {server.state === "installing" ? preparing : STATE_LABEL[server.state]}
        </span>
      </header>
      <p className="runtime-card__description">Languages: {server.languages.join(", ")}</p>
      {!server.installed ? (
        <p className="runtime-card__notes">
          {server.bundled
            ? "Ships with OpenMind: unpacked from the offline bundle when a matching file is opened."
            : "Language server is not installed yet."}
        </p>
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
      <p className="runtime-card__notes">
        {server.bundled || server.installSource === "bundle" ? "Contains" : "Installs"}:{" "}
        {server.contents} · runs on {server.runtime === "native" ? "its own program" : "Node.js"}
      </p>
      {!server.installed && server.installBlocked ? (
        <p className="runtime-card__notes lsp-problem">{server.installBlocked}</p>
      ) : null}
      <div className="runtime-card__install">
        {!server.installed ? (
          <button
            type="button"
            className="button button--primary"
            disabled={!server.canInstall || busy}
            title={
              server.installBlocked ??
              (server.bundled
                ? `Unpack ${server.contents} from the offline bundle now (no download)`
                : `Download and install ${server.contents}`)
            }
            onClick={() => {
              void lsp.install(server.id);
            }}
          >
            {installLabel}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!usable || busy}
          title={
            usable
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
