import { useEffect, useSyncExternalStore } from "react";

import "../../styles/workloads.css";
import { useT } from "../../i18n";
import { container } from "../../services/container";
import { statusLabel } from "../../services/network/networkModel";
import {
  componentName,
  formatBytes,
  runtimeCards,
  selectedCount,
  warningText,
  workloadName,
} from "../../services/workloads/workloadModel";
import type { WorkloadCatalog } from "../../services/workloads/workloadsIpc";
import { SECTIONS, type WorkloadSection, type WorkloadState } from "../../services/workloads/workloadService";
import { PackCard, RuntimeCard, WorkloadCard } from "./WorkloadCards";

function useWorkloads(): WorkloadState {
  return useSyncExternalStore(container.workloads.subscribe, container.workloads.getState);
}

function Summary({ state, catalog }: { state: WorkloadState; catalog: WorkloadCatalog }) {
  const t = useT();
  const network = useSyncExternalStore(container.network.subscribe, container.network.getState);
  const plan = state.plan;
  const count = (kinds: string[]) => plan?.warnings.filter((w) => kinds.includes(w.kind)).length ?? 0;
  const names = catalog.workloads.filter((w) => state.selection.workloads.includes(w.id)).map(workloadName);
  return (
    <aside className="wl-summary" aria-label={t("workloads.summary.title")}>
      <h3>{t("workloads.summary.title")}</h3>
      <p>{t("workloads.summary.selected", { count: selectedCount(state.selection, catalog) })}</p>
      <p>{names.length > 0 ? names.join(", ") : t("workloads.summary.noWorkloads")}</p>
      <dl className="wl-facts">
        <dt>{t("workloads.summary.runtimes")}</dt>
        <dd>
          {plan && plan.install.length > 0
            ? plan.install
                .map((id) => {
                  const c = catalog.components.find((x) => x.id === id);
                  return c ? `${componentName(c)} ${c.version ?? ""}`.trim() : id;
                })
                .join(", ")
            : "—"}
        </dd>
        <dt>{t("workloads.summary.download")}</dt>
        <dd>{formatBytes(plan?.downloadBytes ?? 0)}</dd>
        <dt>{t("workloads.summary.install")}</dt>
        <dd>{formatBytes(plan?.installBytes ?? 0)}</dd>
        <dt>{t("workloads.summary.path")}</dt>
        <dd className="wl-path">{catalog.installRoot}</dd>
        <dt>{t("workloads.summary.proxy")}</dt>
        <dd>{statusLabel(network.status, network.offline.length)}</dd>
        <dt>{t("workloads.summary.offline")}</dt>
        <dd className="wl-path">{catalog.offlineFolder}</dd>
      </dl>
      {plan && plan.unknownSizes > 0 ? <p className="wl-warn">{t("workloads.summary.unknownSizes", { count: plan.unknownSizes })}</p> : null}
      <ul className="wl-counts">
        {count(["heavySdk"]) > 0 ? <li className="wl-warn">{t("workloads.summary.heavy", { count: count(["heavySdk"]) })}</li> : null}
        {count(["externalRequired", "manualInstall"]) > 0 ? (
          <li className="wl-warn">{t("workloads.summary.external", { count: count(["externalRequired", "manualInstall"]) })}</li>
        ) : null}
        {count(["adminRequired"]) > 0 ? <li className="wl-warn">{t("workloads.summary.admin", { count: count(["adminRequired"]) })}</li> : null}
        {count(["unsupportedArchitecture"]) > 0 ? (
          <li className="wl-warn">{t("workloads.summary.unsupported", { count: count(["unsupportedArchitecture"]) })}</li>
        ) : null}
        {count(["licenseAcceptance"]) > 0 ? <li className="wl-warn">{t("workloads.summary.licenses", { count: count(["licenseAcceptance"]) })}</li> : null}
      </ul>
    </aside>
  );
}

function SectionBody({ section, state, catalog }: { section: WorkloadSection; state: WorkloadState; catalog: WorkloadCatalog }) {
  const t = useT();
  const network = useSyncExternalStore(container.network.subscribe, container.network.getState);
  switch (section) {
    case "welcome":
      return (
        <div className="wl-text">
          <p>{t("workloads.welcome.lead")}</p>
          <p>{t("workloads.welcome.policy")}</p>
          <div className="wl-actions">
            <button type="button" className="modal__confirm--primary" onClick={() => { container.workloads.setSection("workloads"); }}>
              {t("workloads.welcome.choose")}
            </button>
            <button type="button" onClick={() => { container.workloads.toggleWorkload("minimal"); container.workloads.setSection("summary"); }}>
              {t("workloads.welcome.minimal")}
            </button>
          </div>
        </div>
      );
    case "location":
      return (
        <div className="wl-text">
          <p>{t("workloads.location.lead")}</p>
          <p className="wl-path">{catalog.installRoot}</p>
          <p>{t("workloads.location.policy")}</p>
        </div>
      );
    case "workloads":
      return (
        <>
          <div className="wl-grid">
            {catalog.workloads.map((w) => (
              <WorkloadCard key={w.id} w={w} catalog={catalog} />
            ))}
          </div>
          <h3 className="wl-h">{t("workloads.runtimes.title")}</h3>
          <div className="wl-grid wl-grid--runtimes">
            {runtimeCards(catalog).map((c) => (
              <RuntimeCard key={c.id} c={c} catalog={catalog} />
            ))}
          </div>
        </>
      );
    case "packs":
      return (
        <div className="wl-grid">
          {catalog.packs.map((p) => (
            <PackCard key={p.id} pack={p} catalog={catalog} />
          ))}
        </div>
      );
    case "network":
      return (
        <div className="wl-text">
          <p>{t("workloads.network.lead")}</p>
          <p className="wl-strong">{statusLabel(network.status, network.offline.length)}</p>
          <div className="wl-actions">
            <button type="button" onClick={() => { void container.network.openWindow("proxy"); }}>
              {t("network.palette.openSettings")}
            </button>
            <button type="button" onClick={() => { container.run("network.testConnection"); }}>
              {t("network.palette.testConnection")}
            </button>
          </div>
        </div>
      );
    case "offline":
      return (
        <div className="wl-text">
          <p>{t("workloads.offline.lead")}</p>
          <p>{t("workloads.offline.count", { count: network.offline.length })}</p>
          <div className="wl-actions">
            <button type="button" onClick={() => { void container.network.chooseImport(); }}>
              {t("network.palette.importOffline")}
            </button>
            <button type="button" onClick={() => { void container.network.openWindow("offline"); }}>
              {t("workloads.offline.open")}
            </button>
          </div>
        </div>
      );
    case "summary":
      return (
        <div className="wl-text">
          {state.plan && state.plan.install.length === 0 ? <p>{t("workloads.summaryPage.nothing")}</p> : null}
          <ul className="wl-warnings">
            {(state.plan?.warnings ?? []).map((w, i) => (
              <li key={`${w.kind}-${w.component}-${String(i)}`}>{warningText(w, catalog)}</li>
            ))}
          </ul>
        </div>
      );
    case "install":
      return <InstallProgress state={state} catalog={catalog} />;
  }
}

function InstallProgress({ state, catalog }: { state: WorkloadState; catalog: WorkloadCatalog }) {
  const t = useT();
  const runtime = useSyncExternalStore(
    (l) => container.runtime.subscribe(l),
    () => container.runtime.getState(),
  );
  const run = state.run;
  if (run === null) return <p className="wl-text">{t("workloads.install.notStarted")}</p>;
  const name = (id: string) => {
    const c = catalog.components.find((x) => x.id === id);
    return c ? componentName(c) : id;
  };
  return (
    <ul className="wl-progress" aria-label={t("workloads.install.title")}>
      {run.queue.map((id) => {
        const failed = run.failed.find((f) => f.id === id);
        const progress = runtime.progress[id];
        const text = failed
          ? t("workloads.install.failedOne", { error: failed.error })
          : run.done.includes(id)
            ? t("workloads.install.done")
            : run.current === id
              ? progress
                ? t("workloads.install.phase", {
                    phase: t(`workloads.phase.${progress.phase}`),
                    percent: progress.total ? Math.round((progress.current / progress.total) * 100) : 0,
                  })
                : t("workloads.install.running")
              : t("workloads.install.queued");
        return (
          <li key={id} className={failed ? "wl-warn" : undefined}>
            <span className="wl-strong">{name(id)}</span> — {text}
          </li>
        );
      })}
    </ul>
  );
}

function LicenseDialog({ ids, catalog }: { ids: string[]; catalog: WorkloadCatalog }) {
  const t = useT();
  const runtimes = useSyncExternalStore(
    (l) => container.runtime.subscribe(l),
    () => container.runtime.getState(),
  );
  return (
    <div className="wl-license" role="dialog" aria-modal="true" aria-label={t("workloads.license.title")}>
      <h3>{t("workloads.license.title")}</h3>
      <p>{t("workloads.license.lead")}</p>
      <ul>
        {ids.map((id) => {
          const r = runtimes.runtimes.find((x) => x.id === id);
          const c = catalog.components.find((x) => x.id === id);
          return (
            <li key={id}>
              <span className="wl-strong">{c ? componentName(c) : id}</span>: {r?.license?.name ?? "—"}{" "}
              {r?.license ? (
                <button type="button" className="wl-link" onClick={() => { void container.ipc.openExternalUrl(r.license?.url ?? ""); }}>
                  {t("workloads.license.read")}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="wl-actions">
        <button type="button" className="modal__confirm--primary" onClick={() => { void container.workloads.answerLicenses(true); }}>
          {t("workloads.license.accept")}
        </button>
        <button type="button" onClick={() => { void container.workloads.answerLicenses(false); }}>
          {t("workloads.license.decline")}
        </button>
      </div>
    </div>
  );
}

/** The workload installer: the first-run page (`firstRun`) or the Runtime Manager's Workloads tab. */
export function WorkloadsPage({ firstRun }: { firstRun: boolean }) {
  const t = useT();
  const state = useWorkloads();
  // While the page is on screen, install changes made elsewhere (the Runtimes tab, Language Tools, another window)
  // re-read the catalog; data that went stale while it was hidden is read again when it comes back.
  useEffect(() => container.workloads.attach(), []);
  useEffect(() => {
    void container.network.load();
  }, []);
  const catalog = state.catalog;
  if (catalog === null) return <p className="wl-text">{state.error ?? t("common.loading")}</p>;
  const plan = state.plan;
  const installing = state.run !== null && !state.run.finished;
  const installReason = installing
    ? t("workloads.install.running")
    : plan === null || plan.install.length === 0
      ? t("workloads.install.nothing")
      : null;
  return (
    <div className="wl">
      <nav className="wl-nav" aria-label={t("workloads.sections")}>
        {SECTIONS.map((section) => (
          <button
            key={section}
            type="button"
            className={state.section === section ? "wl-nav__item wl-nav__item--active" : "wl-nav__item"}
            aria-current={state.section === section ? "step" : undefined}
            onClick={() => { container.workloads.setSection(section); }}
          >
            {t(`workloads.section.${section}`)}
          </button>
        ))}
      </nav>
      <main className="wl-main">
        <h3 className="wl-h">{t(`workloads.section.${state.section}`)}</h3>
        {state.error ? <p className="wl-warn" role="alert">{state.error}</p> : null}
        <SectionBody section={state.section} state={state} catalog={catalog} />
      </main>
      <Summary state={state} catalog={catalog} />
      <footer className="wl-footer">
        <button type="button" disabled={state.section === "welcome"} onClick={() => { container.workloads.back(); }}>
          {t("workloads.action.back")}
        </button>
        <button
          type="button"
          onClick={() => {
            if (firstRun) void container.workloads.skip();
            else container.workloads.toggleWorkload("minimal");
          }}
        >
          {firstRun ? t("workloads.action.skip") : t("workloads.action.clear")}
        </button>
        <button type="button" onClick={() => { void container.network.chooseImport(); }}>
          {t("workloads.action.import")}
        </button>
        {state.section !== "install" ? (
          <button type="button" onClick={() => { container.workloads.next(); }}>
            {t("workloads.action.next")}
          </button>
        ) : null}
        <button
          type="button"
          className="modal__confirm--primary"
          disabled={installReason !== null}
          title={installReason ?? undefined}
          onClick={() => {
            container.workloads.setSection("install");
            void container.workloads.installSelected();
          }}
        >
          {t("workloads.action.install")}
        </button>
      </footer>
      {state.pendingLicenses ? <LicenseDialog ids={state.pendingLicenses} catalog={catalog} /> : null}
    </div>
  );
}

/** The first-run page over the workbench (once; Skip or Close marks it done). */
export function FirstRunWorkloads() {
  const t = useT();
  const { firstRunOpen } = useWorkloads();
  if (!firstRunOpen) return null;
  return (
    <div className="modal-overlay">
      <div className="modal modal--workloads" role="dialog" aria-modal="true" aria-labelledby="wl-title">
        <div className="wl-title">
          <h2 id="wl-title">{t("workloads.firstRun.title")}</h2>
          <button type="button" aria-label={t("common.close")} onClick={() => { void container.workloads.close(); }}>
            &times;
          </button>
        </div>
        <WorkloadsPage firstRun />
      </div>
    </div>
  );
}
