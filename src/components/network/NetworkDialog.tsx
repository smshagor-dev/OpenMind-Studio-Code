import { useEffect, useSyncExternalStore } from "react";

import "../../styles/network.css";
import { useT } from "../../i18n";
import { container } from "../../services/container";
import { statusLabel } from "../../services/network/networkModel";
import { NetworkOfflineTab } from "./NetworkOfflineTab";
import { NetworkProxyTab } from "./NetworkProxyTab";

/** Network: proxy settings and offline packages. Opening it reads local state only; nothing is contacted. */
export function NetworkDialog() {
  const t = useT();
  const state = useSyncExternalStore(container.network.subscribe, container.network.getState);
  useEffect(() => {
    if (!state.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") container.network.closeWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [state.open]);
  if (!state.open) return null;
  const tabs = [
    ["proxy", t("network.tab.proxy")],
    ["offline", t("network.tab.offline")],
  ] as const;
  return (
    <div
      className="modal-overlay"
      onClick={() => {
        container.network.closeWindow();
      }}
    >
      <div
        className="modal modal--network"
        role="dialog"
        aria-modal="true"
        aria-labelledby="network-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="network-title">{t("network.title")}</h2>
        <div className="network__tabs" role="tablist">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={state.tab === id}
              className={state.tab === id ? "network__tab network__tab--active" : "network__tab"}
              onClick={() => {
                container.network.setTab(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {state.error !== null ? (
          <p className="network__warning" role="alert">
            {state.error}
          </p>
        ) : null}
        {state.notice !== null ? (
          <p className="network__ok" role="status">
            {state.notice}
          </p>
        ) : null}
        {state.tab === "proxy" ? <NetworkProxyTab state={state} /> : <NetworkOfflineTab state={state} />}
        <p className="network__policy">{t("network.policy")}</p>
        <div className="modal__actions">
          <button
            type="button"
            className="modal__confirm--primary"
            onClick={() => {
              container.network.closeWindow();
            }}
          >
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The card shown after a tool failed on the network: what happened and what to do next. */
export function NetworkFailureCard() {
  const t = useT();
  const { failure } = useSyncExternalStore(container.network.subscribe, container.network.getState);
  if (failure === null) return null;
  const network = container.network;
  const hint = network.failureHint(failure);
  return (
    <div className="network-failure" role="alert">
      <p className="network-failure__text">{network.failureText(failure)}</p>
      {hint !== null ? <p className="network-failure__hint">{hint}</p> : null}
      <div className="network-failure__actions">
        <button
          type="button"
          onClick={() => {
            // The card stays, so Retry is there once the proxy is configured.
            void network.openWindow("proxy");
          }}
        >
          {t("network.failure.configure")}
        </button>
        {failure.retry !== null ? (
          <button
            type="button"
            onClick={() => {
              network.retryFailure();
            }}
          >
            {failure.retryIsCommand ? t("network.failure.retryCommand") : t("network.failure.retry")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            void network.openProxyReadyTerminal();
          }}
        >
          {t("network.failure.newTerminal")}
        </button>
        <button
          type="button"
          onClick={() => {
            void network.chooseImport();
          }}
        >
          {t("network.failure.import")}
        </button>
        <button
          type="button"
          onClick={() => {
            void network.useOfflineCache();
          }}
        >
          {t("network.failure.offline")}
        </button>
        <button
          type="button"
          className="network-failure__dismiss"
          aria-label={t("common.dismiss")}
          onClick={() => {
            network.dismissFailure();
          }}
        >
          &times;
        </button>
      </div>
    </div>
  );
}

/** "Network: Manual Proxy" in the terminal panel's header; a click opens the proxy settings. */
export function NetworkStatusButton() {
  const { status, offline, staleTerminals } = useSyncExternalStore(
    container.network.subscribe,
    container.network.getState,
  );
  const activeId = useSyncExternalStore(
    (listener) => container.terminal.subscribe(listener),
    () => container.terminal.getState().activeId,
  );
  const t = useT();
  const stale = activeId !== null && staleTerminals.includes(activeId);
  const label = statusLabel(status, offline.length);
  return (
    <button
      type="button"
      className={stale ? "terminal-panel__action network-status network-status--stale" : "terminal-panel__action network-status"}
      title={stale ? t("network.terminal.staleTitle") : t("network.palette.openSettings")}
      onClick={() => {
        container.run("network.openSettings");
      }}
    >
      {stale ? `⚠ ${label}` : label}
    </button>
  );
}

/**
 * Above a terminal opened before the last proxy change: it still has the old proxy variables. The user decides:
 * a new terminal, a restart of this one (asked first), or keep it as it is.
 */
export function StaleTerminalBanner() {
  const t = useT();
  const { staleTerminals } = useSyncExternalStore(container.network.subscribe, container.network.getState);
  const activeId = useSyncExternalStore(
    (listener) => container.terminal.subscribe(listener),
    () => container.terminal.getState().activeId,
  );
  if (activeId === null || !staleTerminals.includes(activeId)) return null;
  const network = container.network;
  return (
    <div className="network-stale" role="status">
      <span className="network-stale__text">{t("network.stale.banner")}</span>
      <button
        type="button"
        onClick={() => {
          void network.openProxyReadyTerminal(activeId);
        }}
      >
        {t("network.failure.newTerminal")}
      </button>
      <button
        type="button"
        onClick={() => {
          void network.restartTerminal(activeId);
        }}
      >
        {t("network.stale.restart")}
      </button>
      <button
        type="button"
        onClick={() => {
          network.keepTerminal(activeId);
        }}
      >
        {t("network.stale.keep")}
      </button>
    </div>
  );
}
