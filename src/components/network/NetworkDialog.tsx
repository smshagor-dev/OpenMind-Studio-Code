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
  return (
    <div className="network-failure" role="alert">
      <p className="network-failure__text">{network.failureText(failure)}</p>
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
            {t("network.failure.retry")}
          </button>
        ) : null}
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
  const { status, offline } = useSyncExternalStore(
    container.network.subscribe,
    container.network.getState,
  );
  const t = useT();
  const label = statusLabel(status, offline.length);
  return (
    <button
      type="button"
      className="terminal-panel__action network-status"
      title={t("network.palette.openSettings")}
      onClick={() => {
        container.run("network.openSettings");
      }}
    >
      {label}
    </button>
  );
}
