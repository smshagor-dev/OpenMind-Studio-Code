import { useEffect, useState } from "react";
import { container } from "../../services/container";
import type { AgentOverview, CloudStatus, ModelView } from "../../services/agent/agentIpc";
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

/** The Offline tab's content: runtime install + the downloadable editions. Exported so Agent Settings (the
 * gear icon) shows the exact same thing as Agent Setup (the model chip / "Configure now") instead of its
 * own, inconsistent summary — the two were different dialogs for the same two tabs, which is the bug this
 * component existing twice was actually about. */
export function LocalSection({ overview, downloads, modelId, installing }: {
  overview: AgentOverview; downloads: Record<string, DownloadState>; modelId: string | null; installing: boolean;
}) {
  const t = useT();
  return (
    <>
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
    </>
  );
}

/** Where a user gets their own OpenMindAI Cloud API key (a user-facing account site — separate from the
 * `api.openmindai.org` API host the app actually talks to). */
const CLOUD_KEY_SIGNUP_URL = "https://chat.openmindai.org";

/** The whole Online tab, in both the Setup dialog (model chip / "Configure now") and the Settings dialog
 * (gear icon) — one real page, not fragments: the connection (address/key/test) and the model choice
 * together, since one key is what unlocks all three published models. Earlier this showed three
 * near-identical cards (same description, same "Runs on OpenMindAI Cloud" text) with their own "Use"
 * button each, as if they were three separate downloads like the local editions — they are not: a single
 * key enables all of them server-side, so the model is one dropdown, not three cards. */
export function CloudSetup({ cloud }: { cloud: CloudStatus | null | undefined; modelId?: string | null }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseUrlDraft, setBaseUrlDraft] = useState(cloud?.baseUrl ?? "");
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  // null = nothing picked by hand yet -- the dropdown shows a derived default instead (below), so the
  // default follows a changing `cloud`/`modelId` live without a setState-in-an-effect anti-pattern; once
  // the user picks something by hand it sticks for the rest of this session.

  useEffect(() => {
    let active = true;
    void agent.loadCloudStatus().then(() => {
      if (!active) return;
      const next = agent.getState().cloud;
      if (next) setBaseUrlDraft((prev) => prev || next.baseUrl);
    });
    return () => { active = false; };
  }, []);

  if (!cloud) return <p className="agent-model__progress-text">{t("agent.loading")}</p>;

  return (
    <fieldset className="agent-cloud-settings">
      <legend>{t("agent.cloud.settings.title")}</legend>
      <p className="agent-cloud-settings__description">{t("agent.cloud.settings.description")}</p>
      <label className="agent-cloud-settings__key-row">
        <span>{t("agent.cloud.settings.baseUrl")}</span>
        <span className="agent-cloud-settings__key-input">
          <input type="text" value={baseUrlDraft} spellCheck={false}
            onChange={(event) => { setBaseUrlDraft(event.target.value); }} />
          <button type="button" className="button button--secondary" disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void agent.setCloudBaseUrl(baseUrlDraft).catch((err: unknown) => { setError(String(err)); })
                .finally(() => { setBusy(false); });
            }}>
            {t("agent.cloud.settings.saveBaseUrl")}
          </button>
        </span>
      </label>
      <p className="agent-cloud-settings__hint">
        {t("agent.cloud.settings.getKeyHint")}{" "}
        <button type="button" className="agent-link-button" onClick={() => void container.ipc.openExternalUrl(CLOUD_KEY_SIGNUP_URL)}>
          {CLOUD_KEY_SIGNUP_URL}
        </button>
      </p>
      <label className="agent-cloud-settings__key-row">
        <span>{t("agent.cloud.settings.apiKey")}</span>
        <span className="agent-cloud-settings__key-input">
          <input type={showKey ? "text" : "password"} value={keyDraft}
            placeholder={cloud.hasKey ? t("agent.cloud.settings.keyStored") : ""} autoComplete="off"
            onChange={(event) => { setKeyDraft(event.target.value); }} />
          <button type="button" className="agent-icon-button" onClick={() => { setShowKey(!showKey); }}>
            {showKey ? t("agent.cloud.settings.hide") : t("agent.cloud.settings.show")}
          </button>
        </span>
      </label>
      <div className="agent-cloud-settings__actions">
        <button type="button" className="button button--primary" disabled={!keyDraft.trim() || busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void agent.setCloudKey(keyDraft).then(() => { setKeyDraft(""); })
              .catch((err: unknown) => { setError(String(err)); }).finally(() => { setBusy(false); });
          }}>
          {t("agent.cloud.settings.saveKey")}
        </button>
        {cloud.hasKey ? (
          <button type="button" className="button button--secondary" disabled={busy}
            onClick={() => {
              setBusy(true);
              void agent.clearCloudKey().finally(() => { setBusy(false); });
            }}>
            {t("agent.cloud.settings.disconnect")}
          </button>
        ) : null}
        <button type="button" className="button button--secondary" disabled={!cloud.hasKey || testing}
          onClick={() => {
            setTesting(true);
            setError(null);
            void agent.testCloudConnection().then((models) => {
              setTesting(false);
              if (models === null) setError(agent.getState().cloudError ?? t("agent.ui.operationFailed"));
            });
          }}>
          {testing ? t("agent.cloud.settings.testing") : t("agent.cloud.settings.test")}
        </button>
      </div>
      {error ? <p className="agent-notice agent-notice--error" role="alert">{error}</p> : null}
      <div className="agent-cloud-settings__models">
        <strong>{t("agent.cloud.setup.modelLabel")}</strong>
        <ul>
          {cloud.models.map((model) => (
            <li key={model.id}>{model.name} — {model.available ? "Available" : "Not confirmed"}</li>
          ))}
        </ul>
        <p className="agent-model__progress-text">
          OpenMindAI Cloud models are managed separately from the local coding assistant.
        </p>
      </div>
    </fieldset>
  );
}

export function AgentSetup({ overview, downloads, modelId, installing }: {
  overview: AgentOverview; downloads: Record<string, DownloadState>; modelId: string | null; installing: boolean;
  cloud?: CloudStatus | null;
}) {
  const t = useT();
  return (
    <div className="agent-setup">
      <p className="agent-model__progress-text">
        {t("agent.setup.hardware", { ram: formatBytes(overview.hardware.totalRamBytes),
          threads: overview.hardware.cpuThreads,
          disk: overview.freeDiskBytes === null ? "—" : formatBytes(overview.freeDiskBytes) })}
      </p>
      <p className="agent-setup__subtitle">Local AI runs entirely on this computer.</p>
      <LocalSection overview={overview} downloads={downloads} modelId={modelId} installing={installing} />
      <p className="agent-setup__privacy">{t("agent.ui.privacy")}</p>
    </div>
  );
}
