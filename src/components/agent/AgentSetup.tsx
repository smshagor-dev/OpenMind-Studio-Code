import { useState } from "react";
import { container } from "../../services/container";
import type { AgentOverview, ModelView } from "../../services/agent/agentIpc";
import type { DownloadState } from "../../services/agent/agentService";
import { formatBytes } from "../../services/agent/agentModel";
import { agentTier } from "../../services/agent/agentBrand";
import { agent } from "../../services/agent";
import { useT } from "../../i18n";

function Progress({ state }: { state: DownloadState }) {
  const t = useT();
  const p = state.progress;
  const share = p && p.totalBytes > 0 ? Math.min(100, Math.round((p.doneBytes / p.totalBytes) * 100)) : 0;
  return (
    <div className="agent-model__progress" aria-live="polite">
      <div className="agent-model__bar" role="progressbar" aria-label={t("agent.ui.downloading")} aria-valuenow={share} aria-valuemin={0} aria-valuemax={100}>
        <div className="agent-model__bar-fill" style={{ width: `${share}%` }} />
      </div>
      <span className="agent-model__progress-text">
        {p === null ? t("agent.download.starting") : t(p.phase === "verifying" ? "agent.download.verifying" : "agent.download.progress", {
          percent: share, done: formatBytes(p.doneBytes), total: formatBytes(p.totalBytes),
        })}
      </span>
    </div>
  );
}

function Edition({ model, selected, download, recommended }: {
  model: ModelView; selected: boolean; download: DownloadState | undefined; recommended: boolean;
}) {
  const t = useT();
  const [accepted, setAccepted] = useState(false);
  const ready = model.local.state === "ready";
  const switching = agent.getState().engineState === "loading" || agent.getState().transcript.busy;
  const running = model.downloading || (download !== undefined && download.error === null);
  return (
    <div className={selected ? "agent-model agent-model--selected" : "agent-model"}>
      <div className="agent-model__head">
        <span className="agent-model__name">OpenMindAI Agent</span>
        <span className="agent-tier">{agentTier(model)}</span>
        {recommended ? <span className="agent-model__badge">{t("agent.model.recommended")}</span> : null}
      </div>
      <p className="agent-model__description">{t(`agent.ui.edition.${model.totalParamsB > 100 ? "max" : model.totalParamsB > 4 ? "pro" : "lite"}`)}</p>
      <p className="agent-model__progress-text">{t("agent.setup.requirements", { size: formatBytes(model.sizeBytes), memory: formatBytes(model.fit.neededBytes) })}</p>
      <p className="agent-model__progress-text">{t("agent.setup.minimum", { ram: formatBytes(Math.ceil((model.fit.neededBytes + 3 * 1024 ** 3) / 0.85 / 1024 ** 3) * 1024 ** 3) })}</p>
      <p className="agent-model__progress-text">{t(`agent.fit.${model.fit.level}`, { speed: model.fit.tokensPerSecond, needed: formatBytes(model.fit.neededBytes) })}</p>
      {running && download ? <Progress state={download} /> : null}
      {download?.error ? <div className="agent-model__error" role="alert">{t("agent.ui.downloadFailed")}</div> : null}
      {!ready && !running ? (
        <div className="agent-license">
          <label><input type="checkbox" checked={accepted} onChange={(event) => { setAccepted(event.target.checked); }} /> {t("agent.ui.acceptLicense")}</label>
          <button type="button" onClick={() => void container.ipc.openExternalUrl(model.license.url)}>{t("agent.ui.license")}</button>
        </div>
      ) : null}
      <div className="agent-model__actions">
        {ready ? (
          <>
            <button type="button" className="button button--primary" disabled={selected || switching} onClick={() => { void agent.selectModel(model.id); }}>
              {selected ? t("agent.model.inUse") : t("agent.model.use")}
            </button>
            <button type="button" className="button button--secondary" disabled={switching} onClick={() => void agent.deleteModel(model.id)}>
              {t("agent.model.delete")}
            </button>
          </>
        ) : running ? (
          <button type="button" className="button button--secondary" onClick={() => void agent.cancelDownload(model.id)}>
            {t("agent.model.stop")}
          </button>
        ) : (
          <button type="button" className="button button--primary" disabled={!accepted || model.fit.level === "tooBig"} onClick={() => void agent.download(model.id, accepted)}>
            {model.local.state === "partial" ? t("agent.model.resume") : t("agent.model.download")}
          </button>
        )}
      </div>
      {model.fit.level === "tooBig" && !ready ? <div className="agent-model__progress-text">{t("agent.ui.needsMemory")}</div> : null}
    </div>
  );
}

export function AgentSetup({ overview, downloads, modelId, installing }: {
  overview: AgentOverview; downloads: Record<string, DownloadState>; modelId: string | null; installing: boolean;
}) {
  const t = useT();
  return (
    <div className="agent-setup">
      <p className="agent-model__progress-text">{t("agent.setup.hardware", { ram: formatBytes(overview.hardware.totalRamBytes), threads: overview.hardware.cpuThreads, disk: overview.freeDiskBytes === null ? "—" : formatBytes(overview.freeDiskBytes) })}</p>
      <p className="agent-setup__subtitle">{t("agent.ui.setupSubtitle")}</p>
      <section className="agent-setup__step">
        <div className="agent-setup__step-title">1. {t("agent.ui.runtime")}</div>
        {overview.engineInstalled ? <div className="agent-setup__done">✓ {t("agent.ui.runtimeReady")}</div> : (
          <div className="agent-setup__engine">
            <span>{t("agent.ui.runtimeDescription")}</span>
            <button type="button" className="button button--primary" disabled={installing} onClick={() => void agent.installEngine()}>
              {installing ? t("agent.setup.installing") : t("agent.setup.install")}
            </button>
          </div>
        )}
      </section>
      <section className="agent-setup__step">
        <div className="agent-setup__step-title">2. {t("agent.ui.chooseEdition")}</div>
        <div className="agent-setup__models">
          {overview.models.map((model) => (
            <Edition key={model.id} model={model} selected={model.id === modelId && model.local.state === "ready"}
              recommended={model.id === overview.recommended} download={downloads[model.id]} />
          ))}
        </div>
      </section>
      <p className="agent-setup__privacy">{t("agent.ui.privacy")}</p>
    </div>
  );
}
