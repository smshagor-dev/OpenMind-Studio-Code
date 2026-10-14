import type { AgentOverview, FitLevel, ModelView } from "../../services/agent/agentIpc";
import type { DownloadState } from "../../services/agent/agentService";
import { formatBytes } from "../../services/agent/agentModel";
import { agent } from "../../services/agent";
import { useT } from "../../i18n";

const FIT_KEYS: Record<FitLevel, string> = {
  gpu: "agent.fit.gpu",
  mixed: "agent.fit.mixed",
  cpu: "agent.fit.cpu",
  slow: "agent.fit.slow",
  tooBig: "agent.fit.tooBig",
};

function HardwareLine({ overview }: { overview: AgentOverview }) {
  const t = useT();
  const hw = overview.hardware;
  const gpu = hw.gpus.reduce<AgentOverview["hardware"]["gpus"][number] | null>(
    (best, g) => (best === null || g.vramBytes > best.vramBytes ? g : best),
    null,
  );
  const parts = [
    t("agent.hw.memory", { size: formatBytes(hw.totalRamBytes) }),
    gpu ? t("agent.hw.gpu", { name: gpu.name, size: formatBytes(gpu.vramBytes) }) : t("agent.hw.noGpu"),
    t("agent.hw.threads", { count: hw.cpuThreads }),
  ];
  return <div className="agent-setup__hardware">{parts.join(" · ")}</div>;
}

function Progress({ state }: { state: DownloadState }) {
  const t = useT();
  const p = state.progress;
  const share = p && p.totalBytes > 0 ? Math.min(100, Math.round((p.doneBytes / p.totalBytes) * 100)) : 0;
  return (
    <div className="agent-model__progress">
      <div className="agent-model__bar" role="progressbar" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100}>
        <div className="agent-model__bar-fill" style={{ width: `${share}%` }} />
      </div>
      <span className="agent-model__progress-text">
        {p === null
          ? t("agent.download.starting")
          : t(p.phase === "verifying" ? "agent.download.verifying" : "agent.download.progress", {
              percent: share,
              done: formatBytes(p.doneBytes),
              total: formatBytes(p.totalBytes),
            })}
      </span>
    </div>
  );
}

function ModelCard({
  model,
  recommended,
  selected,
  download,
}: {
  model: ModelView;
  recommended: boolean;
  selected: boolean;
  download: DownloadState | undefined;
}) {
  const t = useT();
  const ready = model.local.state === "ready";
  const fitLabel = t(FIT_KEYS[model.fit.level], {
    speed: Math.round(model.fit.tokensPerSecond),
    needed: formatBytes(model.fit.neededBytes),
  });
  const running = model.downloading || (download !== undefined && download.error === null);
  return (
    <div className={selected ? "agent-model agent-model--selected" : "agent-model"}>
      <div className="agent-model__head">
        <span className="agent-model__name">{model.name}</span>
        <span className="agent-model__quant">{model.quant}</span>
        {recommended ? <span className="agent-model__badge">{t("agent.model.recommended")}</span> : null}
      </div>
      <div className="agent-model__meta">
        {formatBytes(model.sizeBytes)} · {model.publisher}
      </div>
      <p className="agent-model__description">{model.description}</p>
      <div className={`agent-fit agent-fit--${model.fit.level}`}>{fitLabel}</div>
      {running && download ? <Progress state={download} /> : null}
      {download?.error ? <div className="agent-model__error">{download.error}</div> : null}
      <div className="agent-model__actions">
        {ready ? (
          <>
            <button
              type="button"
              className={selected ? "button button--secondary" : "button button--primary"}
              disabled={selected}
              onClick={() => {
                void agent.selectModel(model.id);
                agent.openSetup(false);
              }}
            >
              {selected ? t("agent.model.inUse") : t("agent.model.use")}
            </button>
            <button type="button" className="button button--secondary" onClick={() => void agent.deleteModel(model.id)}>
              {t("agent.model.delete")}
            </button>
          </>
        ) : running ? (
          <button type="button" className="button button--secondary" onClick={() => void agent.cancelDownload(model.id)}>
            {t("agent.model.stop")}
          </button>
        ) : (
          <button
            type="button"
            className="button button--primary"
            disabled={model.fit.level === "tooBig"}
            title={model.fit.level === "tooBig" ? fitLabel : undefined}
            onClick={() => void agent.download(model.id)}
          >
            {model.local.state === "partial" ? t("agent.model.resume") : t("agent.model.download")}
          </button>
        )}
      </div>
    </div>
  );
}

export function AgentSetup({
  overview,
  downloads,
  modelId,
  installing,
  canClose,
}: {
  overview: AgentOverview;
  downloads: Record<string, DownloadState>;
  modelId: string | null;
  installing: boolean;
  canClose: boolean;
}) {
  const t = useT();
  return (
    <div className="agent-setup agent-enter">
      <div className="agent-setup__intro">
        <span className="agent-welcome__star" aria-hidden="true">
          ✻
        </span>
        <div>
          <div className="agent-setup__title">{t("agent.setup.title")}</div>
          <div className="agent-setup__subtitle">{t("agent.setup.subtitle")}</div>
        </div>
        {canClose ? (
          <button type="button" className="agent-icon-button" title={t("agent.setup.close")} onClick={() => { agent.openSetup(false); }}>
            ✕
          </button>
        ) : null}
      </div>
      <HardwareLine overview={overview} />
      <section className="agent-setup__step">
        <div className="agent-setup__step-title">1. {t("agent.setup.engine")}</div>
        {overview.engineInstalled ? (
          <div className="agent-setup__done">✓ {t("agent.setup.engineReady")}</div>
        ) : (
          <div className="agent-setup__engine">
            <span>{t("agent.setup.engineText")}</span>
            <button type="button" className="button button--primary" disabled={installing} onClick={() => void agent.installEngine()}>
              {installing ? t("agent.setup.installing") : t("agent.setup.install")}
            </button>
          </div>
        )}
      </section>
      <section className="agent-setup__step">
        <div className="agent-setup__step-title">2. {t("agent.setup.model")}</div>
        <div className="agent-setup__models">
          {overview.models.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              recommended={model.id === overview.recommended}
              selected={model.id === modelId && model.local.state === "ready"}
              download={downloads[model.id]}
            />
          ))}
        </div>
      </section>
      <div className="agent-setup__folder" title={overview.modelsDir}>
        {t("agent.setup.folder", { path: overview.modelsDir })}
        {overview.freeDiskBytes !== null ? ` · ${t("agent.setup.free", { size: formatBytes(overview.freeDiskBytes) })}` : ""}
      </div>
      <div className="agent-setup__privacy">{t("agent.setup.privacy")}</div>
    </div>
  );
}
