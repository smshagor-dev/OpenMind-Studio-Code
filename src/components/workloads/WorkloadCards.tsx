import { useState } from "react";

import { useT } from "../../i18n";
import { container } from "../../services/container";
import {
  componentName,
  componentNote,
  formatBytes,
  installBlocker,
  packName,
  packState,
  sourceLabel,
  stateLabel,
  workloadName,
  workloadSummary,
} from "../../services/workloads/workloadModel";
import type { ComponentView, Pack, Workload, WorkloadCatalog } from "../../services/workloads/workloadsIpc";

export function StateChip({ state }: { state: ComponentView["state"] }) {
  return <span className={`wl-chip wl-chip--${state}`}>{stateLabel(state)}</span>;
}

/** One component inside a workload: a checkbox (when OpenMind can do something with it), its state and why. */
export function ComponentRow({ c, catalog }: { c: ComponentView; catalog: WorkloadCatalog }) {
  const t = useT();
  const selected = container.workloads.isSelected(c.id);
  const note = componentNote(c);
  const size = c.state === "available" || c.state === "heavySdk" ? formatBytes(c.downloadBytes) : null;
  return (
    <li className="wl-row">
      <label className="wl-row__main">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => {
            container.workloads.toggleComponent(c.id);
          }}
        />
        <span className="wl-row__name">{componentName(c)}</span>
        <StateChip state={c.state} />
        {size ? <span className="wl-row__size">{t("workloads.card.download", { size })}</span> : null}
      </label>
      {note ? <p className="wl-row__note">{note}</p> : null}
      {c.command ? (
        <p className="wl-row__note">
          <code>{c.command}</code>
        </p>
      ) : null}
      {c.found && c.state !== "installed" ? (
        <p className="wl-row__note">{t("workloads.card.found", { path: c.found })}</p>
      ) : null}
      {catalog.platform !== "windows-x64" && c.state === "unsupportedArchitecture" ? (
        <p className="wl-row__note">{catalog.platform}</p>
      ) : null}
    </li>
  );
}

export function WorkloadCard({ w, catalog }: { w: Workload; catalog: WorkloadCatalog }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const selected = container.workloads.getState().selection.workloads.includes(w.id);
  const members = w.components
    .map((id) => catalog.components.find((c) => c.id === id))
    .filter((c): c is ComponentView => c !== undefined);
  const download = members
    .filter((c) => c.state === "available" || c.state === "heavySdk")
    .reduce((sum, c) => sum + (c.provision.type === "runtime" ? (c.downloadBytes ?? 0) : 0), 0);
  const installed = members.filter((c) => c.state === "installed").length;
  return (
    <article className={selected ? "wl-card wl-card--selected" : "wl-card"} aria-label={workloadName(w)}>
      <label className="wl-card__head">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => {
            container.workloads.toggleWorkload(w.id);
          }}
        />
        <span className="wl-card__name">{workloadName(w)}</span>
      </label>
      <p className="wl-card__summary">{workloadSummary(w)}</p>
      <p className="wl-card__meta">
        {w.id === "minimal"
          ? t("workloads.card.nothingToDownload")
          : t("workloads.card.meta", { installed, total: members.length, size: formatBytes(download) })}
      </p>
      {w.frameworks.length > 0 ? (
        <div className="wl-tags">
          {w.frameworks.map((id) => {
            const f = catalog.frameworks.find((x) => x.id === id);
            return f ? (
              <span key={id} className={f.missing.length === 0 ? "wl-tag wl-tag--ready" : "wl-tag"}>
                {f.name}
              </span>
            ) : null;
          })}
        </div>
      ) : null}
      {members.length > 0 ? (
        <button
          type="button"
          className="wl-link"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? t("workloads.card.hideComponents") : t("workloads.card.showComponents", { count: members.length })}
        </button>
      ) : null}
      {open ? (
        <ul className="wl-rows">
          {members.map((c) => (
            <ComponentRow key={c.id} c={c} catalog={catalog} />
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/** A runtime / SDK / tool card: status, version, architecture, source, sizes and its actions. */
export function RuntimeCard({ c, catalog }: { c: ComponentView; catalog: WorkloadCatalog }) {
  const t = useT();
  const [details, setDetails] = useState(false);
  const state = container.workloads.getState();
  const verify = c.runtime ? state.verify[c.runtime] : undefined;
  const blocker = installBlocker(c);
  const busy = state.run !== null && !state.run.finished;
  const installRuntime = c.provision.type === "runtime" ? c.provision.id : null;
  const note = componentNote(c);
  return (
    <article className="wl-rt" aria-label={componentName(c)}>
      <header className="wl-rt__head">
        <span className="wl-rt__name">{componentName(c)}</span>
        <StateChip state={c.state} />
      </header>
      <dl className="wl-facts">
        <dt>{t("workloads.card.version")}</dt>
        <dd>{c.version ?? "—"}</dd>
        <dt>{t("workloads.card.architecture")}</dt>
        <dd>{c.runtime ? catalog.platform : "—"}</dd>
        <dt>{t("workloads.card.source")}</dt>
        <dd>{sourceLabel(c.source)}</dd>
        <dt>{t("workloads.card.downloadSize")}</dt>
        <dd>{formatBytes(c.downloadBytes)}</dd>
        <dt>{t("workloads.card.installSize")}</dt>
        <dd>{formatBytes(c.installBytes)}</dd>
      </dl>
      <div className="wl-actions">
        {installRuntime ? (
          <button
            type="button"
            disabled={blocker !== null || busy}
            title={blocker ?? undefined}
            onClick={() => {
              void container.workloads.installOne(installRuntime, c.licenseAcceptance);
            }}
          >
            {t("workloads.card.install")}
          </button>
        ) : null}
        {installRuntime && c.state === "installed" ? (
          <button
            type="button"
            onClick={() => {
              void container.workloads.verify(installRuntime);
            }}
          >
            {t("workloads.card.verify")}
          </button>
        ) : null}
        {installRuntime ? (
          <button
            type="button"
            onClick={() => {
              void container.network.chooseImport();
            }}
          >
            {t("workloads.card.import")}
          </button>
        ) : null}
        <button
          type="button"
          aria-expanded={details}
          onClick={() => {
            setDetails(!details);
          }}
        >
          {t("workloads.card.details")}
        </button>
      </div>
      {blocker !== null && c.state !== "installed" ? <p className="wl-rt__reason">{blocker}</p> : null}
      {verify ? (
        <p className={verify.ok ? "wl-ok" : "wl-warn"} role="status">
          {verify.ok ? t("workloads.card.verified", { version: verify.text }) : verify.text}
        </p>
      ) : null}
      {details ? (
        <div className="wl-rt__details">
          {note && blocker !== note ? <p>{note}</p> : null}
          {c.found ? <p>{t("workloads.card.found", { path: c.found })}</p> : null}
          {c.requires.length > 0 ? (
            <p>
              {t("workloads.card.requires", {
                names: c.requires
                  .map((id) => catalog.components.find((x) => x.id === id))
                  .filter((x): x is ComponentView => x !== undefined)
                  .map(componentName)
                  .join(", "),
              })}
            </p>
          ) : null}
          {c.licenseAcceptance ? <p>{t("workloads.card.licenseNeeded")}</p> : null}
          {c.runtime ? <p>{t("workloads.card.logs")}</p> : null}
        </div>
      ) : null}
    </article>
  );
}

export function PackCard({ pack, catalog }: { pack: Pack; catalog: WorkloadCatalog }) {
  const t = useT();
  const st = packState(pack, catalog);
  const members = pack.components
    .map((id) => catalog.components.find((c) => c.id === id))
    .filter((c): c is ComponentView => c !== undefined);
  const allSelected = members.every((c) => container.workloads.isSelected(c.id));
  const download = members
    .filter((c) => (c.state === "available" || c.state === "heavySdk") && c.provision.type === "runtime")
    .reduce((sum, c) => sum + (c.downloadBytes ?? 0), 0);
  const sources = [...new Set(members.map((c) => sourceLabel(c.source)))].join(", ");
  return (
    <article className={allSelected ? "wl-card wl-card--selected" : "wl-card"} aria-label={packName(pack)}>
      <label className="wl-card__head">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => {
            container.workloads.togglePack(pack);
          }}
        />
        <span className="wl-card__name">{t("workloads.pack.title", { name: packName(pack) })}</span>
      </label>
      <p className="wl-card__meta">
        {t("workloads.pack.status", { installed: st.installed, total: st.total, size: formatBytes(download) })}
      </p>
      <p className="wl-card__meta">{t("workloads.pack.sources", { sources })}</p>
      <div className="wl-tags">
        {members.map((c) => (
          <span key={c.id} className={c.state === "installed" ? "wl-tag wl-tag--ready" : "wl-tag"} title={stateLabel(c.state)}>
            {componentName(c)}
          </span>
        ))}
      </div>
      <p className="wl-card__meta">{t("workloads.pack.versions")}</p>
    </article>
  );
}
