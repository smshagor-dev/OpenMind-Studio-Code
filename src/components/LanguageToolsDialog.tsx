import { useEffect, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { LspBundleInfo, LspServerInfo } from "../services/ipc";
import { removeBlocked } from "../services/lspAvailability";
import { t } from "../i18n";
// Its own layout: this dialog is a lazy chunk that can open before the Runtime Manager (which also imports it) ever has,
// and without the stylesheet it was a fixed 460px box that ran off the bottom of the window.
import "../styles/toolchains.css";

const STATE_LABEL: Record<LspServerInfo["state"], string> = {
  running: "lsp.state.running",
  starting: "lsp.state.starting",
  stopped: "lsp.state.stopped",
  installing: "lsp.state.installing",
  error: "lsp.state.error",
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
        <div className="rm-head">
          <h2 id="language-tools-title">{t("runtimes.tab.tools")}</h2>
          <p className="runtimes__intro">{t("lsp.intro")}</p>
        </div>
        {/* One scrolling body between the fixed header and the Close button, like the Runtime Manager. */}
        <div className="rm-body lsp-tools__body" data-testid="lsp-tools-body">
        {snapshot === null ? <p className="runtimes__loading">{t("common.loading")}</p> : null}
        {snapshot ? <BundleLine bundle={snapshot.bundle} /> : null}
        {snapshot?.node ? (
          <p className="runtime-card__notes" data-testid="lsp-node">
            {t("lsp.node", { node: snapshot.node })}
          </p>
        ) : null}
        {snapshot?.nodeProblem ? (
          <p className="runtime-card__notes lsp-problem" role="status">
            {snapshot.nodeProblem} {t("lsp.installNode")}
          </p>
        ) : null}
        {snapshot !== null && snapshot.workspace === null ? (
          <p className="runtime-card__notes">{t("lsp.openFolder")}</p>
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
            {t("lsp.verbose")}
          </label>
          <button
            type="button"
            onClick={() => {
              container.run("lsp.openOutput");
              onClose();
            }}
          >
            {t("lsp.openOutput")}
          </button>
        </div>
        </div>
        <div className="modal__actions">
          <button type="button" onClick={onClose} autoFocus>
            {t("common.close")}
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
        {bundle.nodeVersion
          ? t("lsp.bundleWithNode", { count: bundle.packs, node: bundle.nodeVersion })
          : t("lsp.bundle", { count: bundle.packs })}
      </p>
    );
  }
  return (
    <p className="runtime-card__notes" data-testid="lsp-bundle">
      {bundle.problem ?? t("lsp.noBundle")} {t("lsp.fromNpm")}
    </p>
  );
}

/** What a server runs on, for "runs on {runtime}": Node.js, Python (fortls) or its own program. */
function runtimeName(runtime: LspServerInfo["runtime"]): string {
  if (runtime === "native") return t("lsp.ownProgram");
  return runtime === "pythonModule" ? "Python" : "Node.js";
}

/** The availability badge: ready (and from where), bundled but not unpacked yet, or missing. */
function availabilityBadge(server: LspServerInfo): { text: string; ready: boolean } {
  if (server.installed) {
    return {
      text: server.installSource === "bundle" ? t("lsp.bundled") : t("runtimes.installed"),
      ready: true,
    };
  }
  return server.bundled
    ? { text: t("lsp.bundled"), ready: true }
    : { text: t("lsp.missing"), ready: false };
}

function ServerCard({ server }: { server: LspServerInfo }) {
  const lsp = container.lsp;
  const busy = server.state === "installing" || server.state === "starting";
  const preparing = server.bundled ? t("lsp.unpacking") : t("runtimes.installing");
  const installLabel =
    server.state === "installing"
      ? preparing
      : server.bundled
        ? t("lsp.unpackNow")
        : t("extensions.installButton");
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
          {server.state === "installing" ? preparing : t(STATE_LABEL[server.state])}
        </span>
      </header>
      <p className="runtime-card__description">
        {t("lsp.languages", { list: server.languages.join(", ") })}
      </p>
      {!server.installed ? (
        <p className="runtime-card__notes">
          {server.bundled
            ? t("lsp.shipsWith")
            : t("lsp.notInstalled")}
        </p>
      ) : null}
      {server.state === "error" && server.message ? (
        <p className="runtime-card__notes lsp-problem">{server.message}</p>
      ) : null}
      {server.state === "running" ? (
        <p className="runtime-card__notes">
          pid {server.pid ?? "?"} · {t("lsp.openFiles", { count: server.openDocuments })} ·{" "}
          {server.node}
        </p>
      ) : null}
      {server.note ? <p className="runtime-card__notes">{server.note}</p> : null}
      <p className="runtime-card__notes">
        {t(server.bundled || server.installSource === "bundle" ? "lsp.contains" : "lsp.installs", {
          contents: server.contents,
          runtime: runtimeName(server.runtime),
        })}
      </p>
      {server.python ? (
        <p
          className={server.pythonIsSystem ? "runtime-card__notes lsp-problem" : "runtime-card__notes"}
          data-testid="lsp-python"
        >
          {server.pythonIsSystem
            ? t("lsp.pythonSystem", { python: server.python })
            : t("lsp.python", { python: server.python })}{" "}
          {server.pythonIsSystem ? (
            <button
              type="button"
              className="button button--link"
              onClick={() => {
                container.run("runtime.manage");
              }}
            >
              {t("lsp.installPython")}
            </button>
          ) : null}
        </p>
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
            title={
              server.installBlocked ??
              (server.bundled
                ? t("lsp.unpackTitle", { contents: server.contents })
                : t("lsp.installTitle", { contents: server.contents }))
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
              ? t("lsp.restartTitle")
              : t("lsp.notInstalled")
          }
          onClick={() => {
            void lsp.restart(server.id);
          }}
        >
          {t("lsp.restart")}
        </button>
        <button
          type="button"
          disabled={server.state !== "running"}
          title={
            server.state === "running" ? t("lsp.stopTitle") : t("lsp.notRunning")
          }
          onClick={() => {
            void lsp.stop(server.id);
          }}
        >
          {t("lsp.stop")}
        </button>
        {server.installed && server.installSource !== "bundle" ? (
          <button
            type="button"
            disabled={removeBlocked(server) !== null}
            title={removeBlocked(server) ?? t("lsp.removeTitle", { name: server.name })}
            onClick={() => {
              void lsp.uninstall(server.id);
            }}
          >
            {t("lsp.remove")}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!server.logExists}
          title={server.logExists ? t("lsp.openLogTitle") : t("lsp.noLog")}
          onClick={() => {
            void lsp.openLog(server.id);
          }}
        >
          {t("lsp.openLogs")}
        </button>
      </div>
    </section>
  );
}
