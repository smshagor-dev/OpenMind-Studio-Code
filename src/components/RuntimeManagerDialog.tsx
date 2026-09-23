import { useEffect, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { InstalledVersion, RuntimeStatus } from "../services/ipc";
import { describeProgress, injectionStatus } from "../services/runtimeService";

/** Terminal > Manage Runtimes: install, switch, repair and remove portable toolchains. */
export function RuntimeManagerDialog({ onClose }: { onClose: () => void }) {
  const state = useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );

  useEffect(() => {
    void container.runtime.initialize();
    void container.runtime.refresh();
  }, []);

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
        aria-labelledby="runtimes-title"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id="runtimes-title">Runtime Manager</h2>
        <p className="runtimes__intro">
          Portable toolchains live inside OpenMind Studio&apos;s own folder. They&apos;re added to
          the PATH of terminals you open next — nothing is installed system-wide and your system
          PATH is never changed.
        </p>
        {!state.loaded ? <p className="runtimes__loading">Loading…</p> : null}
        <div className="runtimes__list">
          {state.runtimes.map((runtime) => (
            <RuntimeCard key={runtime.id} runtime={runtime} />
          ))}
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

function RuntimeCard({ runtime }: { runtime: RuntimeStatus }) {
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
      </header>
      <p className="runtime-card__description">{runtime.description}</p>

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
      {runtime.notes ? <p className="runtime-card__notes">{runtime.notes}</p> : null}
    </section>
  );
}

function VersionRow({ runtime, entry }: { runtime: RuntimeStatus; entry: InstalledVersion }) {
  useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  const service = container.runtime;
  const activate = service.activateAvailability(runtime, entry.version);
  const repair = service.repairAvailability(runtime, entry.version);
  const remove = service.deleteAvailability(runtime);
  const injection = injectionStatus(entry);

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
