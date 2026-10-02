import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type { AddonStatus, InstalledVersion, RuntimeStatus } from "../services/ipc";
import { describeProgress, injectionStatus } from "../services/runtimeService";
import "../styles/toolchains.css";
import { RuntimeDatabaseLine } from "./RuntimeDatabaseLine";
import { ToolsPanel } from "./toolchains/ToolsPanel";
import { WorkloadsPage } from "./workloads/WorkloadsPage";
import { t } from "../i18n";

type Tab = "runtimes" | "tools" | "workloads";

/** Terminal > Manage Runtimes: portable runtimes to install and switch, and the app-local language tools. */
export function RuntimeManagerDialog({ onClose }: { onClose: () => void }) {
  const state = useSyncExternalStore(
    (listener) => container.runtime.subscribe(listener),
    () => container.runtime.getState(),
  );
  // Workloads... (Terminal menu) opens this dialog on the Workloads tab.
  const [tab, setTab] = useState<Tab>(() =>
    container.workloads.peekRequestedTab() === "workloads" ? "workloads" : "runtimes",
  );
  const [runtimeQuery, setRuntimeQuery] = useState("");
  // Cleared once mounted (a discarded first render must not consume the request).
  useEffect(() => {
    container.workloads.takeRequestedTab();
  }, []);
  const [detailsFor, setDetailsFor] = useState<RuntimeStatus | null>(null);
  const filteredRuntimes = useMemo(
    () => filterRuntimes(state.runtimes, runtimeQuery),
    [state.runtimes, runtimeQuery],
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
          <h2 id="runtimes-title">{t("activity.runtimeManager")}</h2>
          <p className="runtimes__intro">
            {t("runtimes.intro")}
          </p>
          <div className="rm-tabs" role="tablist" aria-label={t("runtimes.sections")}>
            {(
              [
                ["runtimes", "runtimes.tab.runtimes"],
                ["tools", "runtimes.tab.tools"],
                ["workloads", "runtimes.tab.workloads"],
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
                {t(label)}
              </button>
            ))}
          </div>
        </div>
        <div className="rm-body" role="tabpanel">
          {tab === "runtimes" ? (
            <>
              <div className="rm-search">
                <input
                  type="search"
                  value={runtimeQuery}
                  aria-label={t("runtimes.searchLabel")}
                  placeholder={t("runtimes.searchPlaceholder")}
                  onChange={(event) => {
                    setRuntimeQuery(event.target.value);
                  }}
                />
                <span className="rm-search__count">
                  {t("runtimes.searchCount", {
                    count: filteredRuntimes.length,
                    total: state.runtimes.length,
                  })}
                </span>
              </div>
              {!state.loaded ? <p className="runtimes__loading">{t("common.loading")}</p> : null}
              {state.loaded && filteredRuntimes.length === 0 ? (
                <p className="runtimes__empty">{t("runtimes.searchEmpty")}</p>
              ) : null}
              <div className="rm-runtimes">
                {filteredRuntimes.map((runtime) => (
                  <RuntimeCard key={runtime.id} runtime={runtime} onDetails={setDetailsFor} />
                ))}
              </div>
            </>
          ) : tab === "tools" ? (
            <ToolsPanel />
          ) : (
            <WorkloadsPage firstRun={false} />
          )}
        </div>
        <div className="modal__actions">
          <button type="button" onClick={onClose} autoFocus>
            {t("common.close")}
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

function filterRuntimes(runtimes: RuntimeStatus[], query: string): RuntimeStatus[] {
  const terms = query
    .toLocaleLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) {
    return runtimes;
  }
  return runtimes.filter((runtime) => {
    const haystack = [
      runtime.id,
      runtime.displayName,
      runtime.description,
      runtime.notes,
      runtime.defaultVersion,
      runtime.globalVersion ?? "",
      runtime.activeVersion ?? "",
      ...runtime.availableVersions,
      ...runtime.requires,
      ...(runtime.license ? [runtime.license.name] : []),
      ...runtime.installed.flatMap((entry) => [
        entry.version,
        entry.path,
        ...entry.features.flatMap((feature) => [feature.id, feature.label, feature.note]),
        ...(entry.addons ?? []).flatMap((addon) => [addon.id, addon.label, addon.description]),
      ]),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
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
              <h4>{t("runtimes.notes")}</h4>
              <p>{runtime.notes}</p>
            </>
          ) : null}
          <h4>{t("runtimes.versions")}</h4>
          <p>
            {runtime.installed.length === 0
              ? t("runtimes.noneInstalled")
              : runtime.installed
                  .map((entry) =>
                    entry.active ? t("runtimes.versionActive", { version: entry.version }) : entry.version,
                  )
                  .join(", ")}
            {runtime.globalVersion ? ` · ${t("runtimes.system", { version: runtime.globalVersion })}` : ""}
          </p>
        </div>
        <div className="modal__actions">
          <button type="button" autoFocus onClick={onClose}>
            {t("common.close")}
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
          {installed ? t("runtimes.installed") : t("runtimes.notInstalled")}
        </span>
        {runtime.activeVersion ? (
          <span className="runtime-card__active">
            {t("runtimes.activeVersion", { version: runtime.activeVersion })}
          </span>
        ) : null}
        {runtime.globalVersion ? (
          <span className="runtime-card__global" title={t("runtimes.onSystemPath")}>
            {t("runtimes.system", { version: runtime.globalVersion })}
          </span>
        ) : null}
        <button
          type="button"
          className="rm-details-button"
          title={t("runtimes.detailsTitle", { name: runtime.displayName })}
          onClick={() => {
            onDetails(runtime);
          }}
        >
          {t("runtimes.details")}
        </button>
      </header>
      <p className="runtime-card__description" title={runtime.description}>
        {runtime.description}
      </p>
      {runtime.id === "mariadb" ? <RuntimeDatabaseLine installed={installed} /> : null}

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
            aria-label={t("runtimes.versionToInstall", { name: runtime.displayName })}
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
            install.reason ??
            t("runtimes.installTitle", { name: runtime.displayName, version: selectable ?? "" })
          }
          onClick={() => {
            void service.install(runtime.id, selectable);
          }}
        >
          {working === "install" ? t("runtimes.installing") : t("extensions.installButton")}
        </button>
      </div>

      {progress ? <ProgressBar progress={progress} /> : null}
      {working === "delete" || working === "activate" ? (
        <p className="runtime-card__working">
          {working === "delete" ? t("runtimes.removing") : t("runtimes.switching")}
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
            {t("common.dismissAction")}
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
    ? { injected: false, label: t("runtimes.debuggerOnly") }
    : injectionStatus(entry);

  return (
    <li className="runtime-version">
      <span className="runtime-version__name">{entry.version}</span>
      {entry.active ? <span className="runtime-badge runtime-badge--active">{t("runtimes.active")}</span> : null}
      {entry.healthy ? null : (
        <span className="runtime-badge runtime-badge--warn">{t("runtimes.needsRepair")}</span>
      )}
      <span className="runtime-version__spacer" />
      {entry.active ? null : (
        <button
          type="button"
          disabled={!activate.enabled}
          title={
            activate.reason ??
            t("runtimes.setActiveTitle", { name: runtime.displayName, version: entry.version })
          }
          onClick={() => {
            void service.setActive(runtime.id, entry.version);
          }}
        >
          {t("runtimes.setActive")}
        </button>
      )}
      <button
        type="button"
        disabled={!repair.enabled}
        title={repair.reason ?? t("runtimes.repairTitle")}
        onClick={() => {
          void service.repair(runtime.id, entry.version);
        }}
      >
        {t("runtimes.repair")}
      </button>
      <button
        type="button"
        className="runtime-version__delete"
        disabled={!remove.enabled}
        title={
          remove.reason ??
          t("runtimes.deleteTitle", { name: runtime.displayName, version: entry.version })
        }
        onClick={() => {
          void service.remove(runtime.id, entry.version);
        }}
      >
        {t("runtimes.delete")}
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
            title={feature.available ? t("runtimes.featureAvailableTitle", { name: feature.label }) : feature.note}
          >
            {feature.available
              ? t("runtimes.featureAvailable", { name: feature.label })
              : t("runtimes.featureMissing", { name: feature.label, note: feature.note })}
          </span>
        ))}
      </div>
      {(entry.addons ?? []).map((addon) => (
        <AddonRow key={addon.id} runtime={runtime} version={entry.version} addon={addon} />
      ))}
    </li>
  );
}

/** An optional part of this version (Tcl/Tk for Python): what it is, and Add / Remove. */
function AddonRow({ runtime, version, addon }: { runtime: RuntimeStatus; version: string; addon: AddonStatus }) {
  const service = container.runtime;
  const busy = service.isBusy(runtime.id);
  const size = addon.downloadBytes === null ? "" : ` · ${(addon.downloadBytes / 1_048_576).toFixed(1)} MB`;
  const license = addon.license === null ? "" : ` · ${addon.license.name}`;
  const reason = busy
    ? t("runtimes.addon.busy", { name: runtime.displayName })
    : !addon.available && !addon.installed
      ? t("runtimes.addon.noDownload")
      : null;
  return (
    <div className="runtime-addon" title={addon.description}>
      <span className={addon.installed ? "runtime-feature" : "runtime-feature runtime-feature--missing"}>
        {addon.installed
          ? t("runtimes.addon.installed", { name: addon.label })
          : t("runtimes.addon.notInstalled", { name: addon.label })}
        <span className="runtime-addon__meta">{`${size}${license}`}</span>
      </span>
      <button
        type="button"
        disabled={reason !== null}
        title={reason ?? (addon.installed ? t("runtimes.addon.removeTitle") : addon.description)}
        onClick={() => {
          void (addon.installed
            ? service.removeAddon(runtime.id, version, addon.id)
            : service.installAddon(runtime.id, version, addon.id));
        }}
      >
        {addon.installed ? t("runtimes.addon.remove") : t("runtimes.addon.add")}
      </button>
    </div>
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
