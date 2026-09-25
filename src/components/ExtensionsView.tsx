import { useSyncExternalStore } from "react";

import { container } from "../services/container";
import { displayName, runtimeStatus } from "../services/extensionModel";
import type { InstalledExtension } from "../services/extensionsIpc";
import "../styles/extensions.css";
import { ExtensionDetails } from "./ExtensionDetails";
import { ExtensionInstallDialog } from "./ExtensionInstallDialog";
import { ConfirmDialog } from "./ConfirmDialog";

function useExtensions() {
  const { registry, service, host } = container.extensions;
  const registryState = useSyncExternalStore(
    (listener) => registry.subscribe(listener),
    () => registry.getState(),
  );
  const ui = useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getState(),
  );
  return { registry, service, host, registryState, ui };
}

function ExtensionRow({ extension }: { extension: InstalledExtension }) {
  const { registry, service, registryState, ui } = useExtensions();
  const snapshot = registryState.snapshot;
  const activity = registry.activityOf(extension.id);
  const runtime = snapshot ? runtimeStatus(extension, snapshot.host, snapshot.node) : null;
  const toggle = service.toggleAvailability(extension);
  const status = !extension.enabled
    ? "Disabled"
    : activity.lastError !== null
      ? "Error"
      : activity.active
        ? "Active"
        : "Enabled";
  return (
    <li
      className={
        ui.selectedId === extension.id ? "ext-row ext-row--selected" : "ext-row"
      }
      data-enabled={extension.enabled}
    >
      <button
        type="button"
        className="ext-row__main"
        aria-label={`${displayName(extension)} details`}
        onClick={() => {
          service.select(ui.selectedId === extension.id ? null : extension.id);
        }}
      >
        <span className="ext-row__name">{displayName(extension)}</span>
        <span className="ext-row__meta">
          {extension.manifest.publisher} · {extension.manifest.version}
        </span>
        <span className="ext-row__desc">{extension.manifest.description ?? ""}</span>
        {runtime && !runtime.ready && extension.enabled ? (
          <span className="ext-row__problem">{runtime.text}</span>
        ) : null}
      </button>
      <span
        className={`ext-status ext-status--${status.toLowerCase()}`}
        title={activity.lastError ?? undefined}
      >
        {status}
      </span>
      <div className="ext-row__actions">
        <button
          type="button"
          className="ext-button"
          disabled={!toggle.enabled}
          title={toggle.enabled ? undefined : toggle.reason}
          onClick={() => {
            void service.setEnabled(extension.id, !extension.enabled);
          }}
        >
          {extension.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          className="ext-button ext-button--danger"
          disabled={!toggle.enabled}
          title={toggle.enabled ? undefined : toggle.reason}
          onClick={() => {
            service.requestUninstall(extension.id);
          }}
        >
          Uninstall
        </button>
      </div>
    </li>
  );
}

function RuntimeBanner() {
  const { service, registryState, host } = useExtensions();
  const problem = service.runtimeProblem();
  const node = registryState.snapshot?.node;
  if (problem === null) return null;
  return (
    <div className="ext-banner ext-banner--problem" role="alert">
      <p>{problem}</p>
      {node && !node.portable && node.system !== null && !node.allowSystem ? (
        <>
          <p className="ext-banner__hint">
            A Node.js was found at {node.system}. OpenMind Studio only uses it if you allow it.
          </p>
          <button
            type="button"
            className="ext-button"
            onClick={() => {
              void service.allowSystemNode();
            }}
          >
            Use System Node.js
          </button>
        </>
      ) : node && !node.portable ? (
        <button
          type="button"
          className="ext-button"
          onClick={() => {
            container.run("runtime.manage");
          }}
        >
          Install Node.js Runtime
        </button>
      ) : (
        <button
          type="button"
          className="ext-button"
          onClick={() => {
            void host.reload();
          }}
        >
          Restart Extension Host
        </button>
      )}
    </div>
  );
}

function Toolbar() {
  const { service, registryState } = useExtensions();
  const install = service.installAvailability();
  const reload = service.reloadAvailability();
  const snapshot = registryState.snapshot;
  return (
    <div className="ext-toolbar">
      <button
        type="button"
        className="ext-button ext-button--primary"
        disabled={!install.enabled}
        title={install.enabled ? "Install an extension from a .vsix file on this computer" : install.reason}
        onClick={() => {
          void service.chooseVsix();
        }}
      >
        Install from VSIX…
      </button>
      <button
        type="button"
        className="ext-button"
        disabled={!reload.enabled}
        title={reload.enabled ? "Stop the extension host; extensions start again when needed" : reload.reason}
        onClick={() => {
          void service.reloadHost();
        }}
      >
        Reload Extension Host
      </button>
      <button
        type="button"
        className="ext-button"
        title="Show the extension host log"
        onClick={() => {
          void service.showLogs();
        }}
      >
        Show Logs
      </button>
      <button
        type="button"
        className="ext-button"
        disabled={snapshot === null}
        title={snapshot === null ? "Extensions aren't loaded yet." : "Open the extensions folder"}
        onClick={() => {
          if (snapshot) void container.ipc.panelOpenFolder(snapshot.root);
        }}
      >
        Open Folder
      </button>
    </div>
  );
}

function Messages() {
  const { service, ui } = useExtensions();
  if (ui.busy === null && ui.notice === null && ui.error === null) return null;
  return (
    <div
      className={ui.error !== null ? "ext-banner ext-banner--problem" : "ext-banner"}
      role={ui.error !== null ? "alert" : "status"}
    >
      <p>{ui.error ?? ui.busy ?? ui.notice}</p>
      {ui.busy === null ? (
        <button
          type="button"
          className="ext-link"
          onClick={() => {
            service.clearMessages();
          }}
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

/** The side bar's Extensions view: installed extensions, search over them, install from a `.vsix`. */
export function ExtensionsView() {
  const { registry, service, registryState, ui } = useExtensions();
  const marketplace = container.extensions.marketplace;
  const visible = registry.visible();
  const total = registry.all().length;
  const selected = ui.selectedId === null ? undefined : registry.find(ui.selectedId);
  const pendingUninstall =
    ui.pendingUninstall === null ? undefined : registry.find(ui.pendingUninstall);
  return (
    <div className="ext-view">
      <Toolbar />
      <input
        type="search"
        className="ext-search"
        placeholder="Search installed extensions"
        aria-label="Search installed extensions"
        value={registryState.query}
        onChange={(event) => {
          registry.setQuery(event.target.value);
        }}
      />
      <p className="ext-marketplace" aria-label="Marketplace">
        {marketplace.message}
      </p>
      <Messages />
      <RuntimeBanner />
      {registryState.error !== null ? (
        <p className="ext-banner ext-banner--problem" role="alert">
          {registryState.error}
        </p>
      ) : null}
      {registryState.snapshot === null && registryState.error === null ? (
        <p className="ext-empty">Loading extensions…</p>
      ) : total === 0 ? (
        <div className="ext-empty">
          <p>No extensions are installed.</p>
          <p className="ext-empty__hint">
            Install one from a .vsix file. OpenMind Studio supports a VS Code API subset.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <p className="ext-empty">No installed extension matches “{registryState.query}”.</p>
      ) : (
        <ul className="ext-list" aria-label="Installed extensions">
          {visible.map((extension) => (
            <ExtensionRow key={extension.id} extension={extension} />
          ))}
        </ul>
      )}
      {(registryState.snapshot?.broken ?? []).map((broken) => (
        <p key={broken.folder} className="ext-banner ext-banner--problem" role="alert">
          {broken.folder}: {broken.error}
        </p>
      ))}
      {selected ? <ExtensionDetails extension={selected} /> : null}
      {ui.logs !== null ? (
        <section className="ext-logs" aria-label="Extension host log">
          <header>
            <h3>Extension host log</h3>
            <button
              type="button"
              className="ext-link"
              onClick={() => {
                service.openLogsFolder();
              }}
            >
              Open logs folder
            </button>
            <button
              type="button"
              className="ext-link"
              onClick={() => {
                service.hideLogs();
              }}
            >
              Close
            </button>
          </header>
          <pre>{ui.logs}</pre>
        </section>
      ) : null}
      {ui.pendingInstall ? <ExtensionInstallDialog pending={ui.pendingInstall} /> : null}
      {pendingUninstall ? (
        <ConfirmDialog
          title="Uninstall Extension"
          message={`Uninstall ${displayName(pendingUninstall)}? Its files are deleted from the extensions folder.`}
          confirmLabel="Uninstall"
          onConfirm={() => {
            void service.confirmUninstall();
          }}
          onCancel={() => {
            service.cancelUninstall();
          }}
        />
      ) : null}
    </div>
  );
}
