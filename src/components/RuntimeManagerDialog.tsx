import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { InstalledVersion, RuntimeStatus } from "../services/ipc";
import { describeProgress, injectionStatus } from "../services/runtimeService";
import "../styles/toolchains.css";
import { ToolsPanel } from "./toolchains/ToolsPanel";

type Tab = "runtimes" | "tools";

/** Terminal > Manage Runtimes: portable runtimes to install and switch, and the app-local language tools. */
export function RuntimeManagerDialog({ onClose }: { onClose: () => void }) {
  const state = useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  const [tab, setTab] = useState<Tab>("runtimes");
  const [detailsFor, setDetailsFor] = useState<RuntimeStatus | null>(null);

  useEffect(() => {
    void container.runtime.initialize();
    void container.runtime.refresh();
  }, []);

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape" && detailsFor === null) onClose();
      }}
    >
      <div
        className="modal modal--runtimes"
        role="dialog"
        aria-modal="true"
        aria-labelledby="runtimes-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="rm-head">
          <h2 id="runtimes-title">Runtime Manager</h2>
          <p className="runtimes__intro">
            Everything here lives inside OpenMind Studio&apos;s own folder. It is added to the PATH
            of terminals and tools OpenMind starts — never to your system PATH.
          </p>
          <div className="rm-tabs" role="tablist" aria-label="Runtime Manager sections">
            {(
              [
                ["runtimes", "Runtimes"],
                ["tools", "Language Tools"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="rm-tab"
                aria-selected={tab === id}
                onClick={() => {
                  setTab(id);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="rm-body" role="tabpanel">
          {tab === "runtimes" ? (
            <>
              {!state.loaded ? <p className="runtimes__loading">Loading…</p> : null}
              <div className="rm-runtimes">
                {state.runtimes.map((runtime) => (
                  <RuntimeCard key={runtime.id} runtime={runtime} onDetails={setDetailsFor} />
                ))}
              </div>
            </>
          ) : (
            <ToolsPanel />
          )}
        </div>
        <div className="modal__actions">
          <button type="button" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        {detailsFor ? (
          <RuntimeDetails
            runtime={detailsFor}
            onClose={() => {
              setDetailsFor(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The long text of a runtime (its full description and notes) — kept out of the card so cards stay short. */
function RuntimeDetails({ runtime, onClose }: { runtime: RuntimeStatus; onClose: () => void }) {
  return (
    <div
      className="modal-overlay tc-details-overlay"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        className="modal tc-details rm-details"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-details-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="tc-details__head">
          <h2 id="rm-details-title">{runtime.displayName}</h2>
        </header>
        <div className="tc-details__body">
          <p>{runtime.description}</p>
          {runtime.notes ? (
            <>
              <h4>Notes</h4>
              <p>{runtime.notes}</p>
            </>
          ) : null}
          <h4>Versions</h4>
          <p>
            {runtime.installed.length === 0
              ? "None installed."
              : runtime.installed
                  .map((entry) => `${entry.version}${entry.active ? " (active)" : ""}`)
                  .join(", ")}
            {runtime.globalVersion ? ` · System: ${runtime.globalVersion}` : ""}
          </p>
        </div>
        <div className="modal__actions">
          <button type="button" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function RuntimeCard({
  runtime,
  onDetails,
}: {
  runtime: RuntimeStatus;
  onDetails: (runtime: RuntimeStatus) => void;
}) {
  const state = useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  const service = container.runtime;
  const [chosen, setChosen] = useState<string | null>(null);
  const version = chosen ?? runtime.defaultVersion;
  const selectable = runtime.availableVersions.includes(version)
    ? version
    : (runtime.availableVersions[0] ?? null);

  const progress = state.progress[runtime.id];
  const working = state.working[runtime.id];
  const error = state.errors[runtime.id];
  const install = service.installAvailability(runtime, selectable);
  const installed = runtime.installed.length > 0;

  return (
    <section className="runtime-card" aria-label={runtime.displayName}>
      <header className="runtime-card__header">
        <h3>{runtime.displayName}</h3>
        <span className={installed ? "runtime-badge runtime-badge--installed" : "runtime-badge"}>
          {installed ? "Installed" : "Not installed"}
        </span>
        {runtime.activeVersion ? (
          <span className="runtime-card__active">Active: {runtime.activeVersion}</span>
        ) : null}
        {runtime.globalVersion ? (
          <span className="runtime-card__global" title="Already on your system PATH">
            System: {runtime.globalVersion}
          </span>
        ) : null}
        <button
          type="button"
          className="rm-details-button"
          title={`Full description and notes for ${runtime.displayName}`}
          onClick={() => {
            onDetails(runtime);
          }}
        >
          Details
        </button>
      </header>
      <p className="runtime-card__description" title={runtime.description}>
        {runtime.description}
      </p>

      {runtime.installed.length > 0 ? (
        <ul className="runtime-card__versions">
          {runtime.installed.map((entry) => (
            <VersionRow key={entry.version} runtime={runtime} entry={entry} />
          ))}
        </ul>
      ) : null}

      <div className="runtime-card__install">
        {runtime.availableVersions.length > 0 ? (
          <select
            aria-label={`${runtime.displayName} version to install`}
            value={selectable ?? ""}
            disabled={working !== undefined}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            {runtime.availableVersions.map((available) => (
              <option key={available} value={available}>
                {available}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="button button--primary"
          disabled={!install.enabled}
          title={
            install.reason ?? `Download and install ${runtime.displayName} ${selectable ?? ""}`
          }
          onClick={() => {
            void service.install(runtime.id, selectable);
          }}
        >
          {working === "install" ? "Installing…" : "Install"}
        </button>
      </div>

      {progress ? <ProgressBar progress={progress} /> : null}
      {working === "delete" || working === "activate" ? (
        <p className="runtime-card__working">
          {working === "delete" ? "Removing…" : "Switching version…"}
        </p>
      ) : null}
      {error ? (
        <div className="runtime-card__error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              service.dismissError(runtime.id);
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Debug adapters are started by the debugger itself; nothing of them is put on a terminal PATH. */
const DEBUG_ADAPTERS = new Set(["debugpy", "js-debug"]);

function VersionRow({ runtime, entry }: { runtime: RuntimeStatus; entry: InstalledVersion }) {
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  const service = container.runtime;
  const activate = service.activateAvailability(runtime, entry.version);
  const repair = service.repairAvailability(runtime, entry.version);
  const remove = service.deleteAvailability(runtime);
  const injection = DEBUG_ADAPTERS.has(runtime.id)
    ? { injected: false, label: "Used only by the debugger — not added to any PATH" }
    : injectionStatus(entry);

  return (
    <li className="runtime-version">
      <span className="runtime-version__name">{entry.version}</span>
      {entry.active ? <span className="runtime-badge runtime-badge--active">Active</span> : null}
      {entry.healthy ? null : (
        <span className="runtime-badge runtime-badge--warn">Needs repair</span>
      )}
      <span className="runtime-version__spacer" />
      {entry.active ? null : (
        <button
          type="button"
          disabled={!activate.enabled}
          title={activate.reason ?? `Use ${runtime.displayName} ${entry.version} in new terminals`}
          onClick={() => {
            void service.setActive(runtime.id, entry.version);
          }}
        >
          Set active
        </button>
      )}
      <button
        type="button"
        disabled={!repair.enabled}
        title={repair.reason ?? "Re-download and reinstall the missing or damaged files"}
        onClick={() => {
          void service.repair(runtime.id, entry.version);
        }}
      >
        Repair
      </button>
      <button
        type="button"
        className="runtime-version__delete"
        disabled={!remove.enabled}
        title={remove.reason ?? `Delete ${runtime.displayName} ${entry.version} from this app`}
        onClick={() => {
          void service.remove(runtime.id, entry.version);
        }}
      >
        Delete
      </button>
      <div className="runtime-version__details">
        <span
          className={
            injection.injected
              ? "runtime-version__terminals"
              : "runtime-version__terminals runtime-version__terminals--off"
          }
        >
          {injection.label}
        </span>
        {entry.features.map((feature) => (
          <span
            key={feature.id}
            className={
              feature.available ? "runtime-feature" : "runtime-feature runtime-feature--missing"
            }
            title={feature.available ? `${feature.label} is available` : feature.note}
          >
            {feature.available
              ? `${feature.label}: available`
              : `${feature.label}: not available — ${feature.note}`}
          </span>
        ))}
      </div>
    </li>
  );
}

function ProgressBar({ progress }: { progress: Parameters<typeof describeProgress>[0] }) {
  const view = describeProgress(progress);
  return (
    <div className="runtime-progress" role="status">
      <div className="runtime-progress__label">
        {view.label} <span className="runtime-progress__version">{progress.version}</span>
      </div>
      <div
        className="runtime-progress__track"
        role="progressbar"
        aria-label={view.label}
        aria-valuenow={view.percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={
            view.percent === null
              ? "runtime-progress__bar runtime-progress__bar--indeterminate"
              : "runtime-progress__bar"
          }
          style={view.percent === null ? undefined : { width: `${String(view.percent)}%` }}
        />
      </div>
    </div>
  );
}
