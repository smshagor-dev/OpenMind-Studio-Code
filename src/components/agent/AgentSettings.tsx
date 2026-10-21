import { AgentCapabilities } from "./AgentCapabilities";
import { useEffect, useState } from "react";
import { agent } from "../../services/agent";
import { container } from "../../services/container";
import type { AgentMode, CloudStatus } from "../../services/agent/agentIpc";
import type { AgentOptions } from "../../services/agent/agentOptions";
import { useT } from "../../i18n";

/** Where a user gets their own OpenMindAI Cloud API key (a user-facing account site — separate from the
 * `api.openmindai.org` API host the app actually talks to). */
const CLOUD_KEY_SIGNUP_URL = "https://chat.openmindai.org";

/** The explicit Local (offline) / Cloud (online) switch: which engine the agent's next message uses. Each
 * side remembers its own last model, so switching back and forth within this session loses nothing. */
function InferenceModeToggle() {
  const t = useT();
  const [mode, setMode] = useState<"local" | "cloud">(agent.inferenceMode());
  const overview = agent.getState().overview;
  const cloud = agent.getState().cloud;
  const localAvailable = overview?.models.some((m) => m.local.state === "ready") ?? false;
  const cloudAvailable = cloud?.models.some((m) => m.available) ?? false;
  const choose = (next: "local" | "cloud") => {
    void agent.toggleInference(next).then(() => {
      setMode(agent.inferenceMode());
    });
  };
  return (
    <fieldset className="agent-inference-toggle">
      <legend>{t("agent.inference.title")}</legend>
      <div className="agent-inference-toggle__options">
        <label className="agent-inference-toggle__option">
          <input
            type="radio"
            name="agent-inference-mode"
            checked={mode === "local"}
            onChange={() => {
              choose("local");
            }}
          />
          <span>{t("agent.inference.local")}</span>
        </label>
        <label className="agent-inference-toggle__option">
          <input
            type="radio"
            name="agent-inference-mode"
            checked={mode === "cloud"}
            onChange={() => {
              choose("cloud");
            }}
          />
          <span>{t("agent.inference.cloud")}</span>
        </label>
      </div>
      {!localAvailable ? <p className="agent-model__progress-text">{t("agent.inference.localDisabledHint")}</p> : null}
      {!cloudAvailable ? <p className="agent-model__progress-text">{t("agent.inference.cloudDisabledHint")}</p> : null}
    </fieldset>
  );
}

/** OpenMindAI Cloud's own, agent-scoped configuration (address, API key, connection test). No request runs
 * until Test Connection, or Send with a cloud model chosen; reading the stored status here is a local
 * settings read, same as the rest of this page. */
function CloudSettingsSection() {
  const t = useT();
  const [status, setStatus] = useState<CloudStatus | null>(agent.getState().cloud ?? null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseUrlDraft, setBaseUrlDraft] = useState(status?.baseUrl ?? "");
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    let active = true;
    void agent.loadCloudStatus().then(() => {
      if (!active) return;
      const next = agent.getState().cloud ?? null;
      setStatus(next);
      setBaseUrlDraft(next?.baseUrl ?? "");
    });
    return () => {
      active = false;
    };
  }, []);

  const sync = () => {
    setStatus(agent.getState().cloud ?? null);
  };

  return (
    <fieldset className="agent-cloud-settings">
      <legend>{t("agent.cloud.settings.title")}</legend>
      <p className="agent-cloud-settings__description">{t("agent.cloud.settings.description")}</p>
      <label className="agent-cloud-settings__key-row">
        <span>{t("agent.cloud.settings.baseUrl")}</span>
        <span className="agent-cloud-settings__key-input">
          <input
            type="text"
            value={baseUrlDraft}
            spellCheck={false}
            onChange={(event) => {
              setBaseUrlDraft(event.target.value);
            }}
          />
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void agent
                .setCloudBaseUrl(baseUrlDraft)
                .then(() => {
                  sync();
                })
                .catch((err: unknown) => {
                  setError(String(err));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            {t("agent.cloud.settings.saveBaseUrl")}
          </button>
        </span>
      </label>
      <p className="agent-cloud-settings__hint">
        {t("agent.cloud.settings.getKeyHint")}{" "}
        <button
          type="button"
          className="agent-link-button"
          onClick={() => void container.ipc.openExternalUrl(CLOUD_KEY_SIGNUP_URL)}
        >
          {CLOUD_KEY_SIGNUP_URL}
        </button>
      </p>
      <label className="agent-cloud-settings__key-row">
        <span>{t("agent.cloud.settings.apiKey")}</span>
        <span className="agent-cloud-settings__key-input">
          <input
            type={showKey ? "text" : "password"}
            value={keyDraft}
            placeholder={status?.hasKey ? t("agent.cloud.settings.keyStored") : ""}
            autoComplete="off"
            onChange={(event) => {
              setKeyDraft(event.target.value);
            }}
          />
          <button
            type="button"
            className="agent-icon-button"
            onClick={() => {
              setShowKey(!showKey);
            }}
          >
            {showKey ? t("agent.cloud.settings.hide") : t("agent.cloud.settings.show")}
          </button>
        </span>
      </label>
      <div className="agent-cloud-settings__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!keyDraft.trim() || busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void agent
              .setCloudKey(keyDraft)
              .then(() => {
                setKeyDraft("");
                sync();
              })
              .catch((err: unknown) => {
                setError(String(err));
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          {t("agent.cloud.settings.saveKey")}
        </button>
        {status?.hasKey ? (
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void agent
                .clearCloudKey()
                .then(() => {
                  sync();
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            {t("agent.cloud.settings.disconnect")}
          </button>
        ) : null}
        <button
          type="button"
          className="button button--secondary"
          disabled={!status?.hasKey || testing}
          onClick={() => {
            setTesting(true);
            setError(null);
            void agent.testCloudConnection().then((models) => {
              setTesting(false);
              if (models === null) {
                setError(agent.getState().cloudError ?? t("agent.ui.operationFailed"));
                return;
              }
              sync();
            });
          }}
        >
          {testing ? t("agent.cloud.settings.testing") : t("agent.cloud.settings.test")}
        </button>
      </div>
      {error ? (
        <p className="agent-notice agent-notice--error" role="alert">
          {error}
        </p>
      ) : null}
      {status ? (
        <ul className="agent-cloud-settings__models">
          {status.models.map((model) => (
            <li key={model.id} className="agent-cloud-settings__model">
              <span className="agent-cloud-settings__model-name">{model.name}</span>
              <span
                className={
                  model.available
                    ? "agent-model__badge"
                    : "agent-model__badge agent-model__badge--muted"
                }
              >
                {model.available
                  ? t("agent.cloud.settings.available")
                  : t("agent.cloud.settings.unavailable")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}

const NUMBERS: {
  key: keyof AgentOptions;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "maxOutputTokens", min: 1024, max: 32768, step: 1024 },
  { key: "reasoningBudgetTokens", min: 0, max: 8192, step: 256 },
  { key: "maxSteps", min: 8, max: 512, step: 1 },
  { key: "maxContinuations", min: 0, max: 16, step: 1 },
  { key: "temperature", min: 0, max: 1, step: 0.1 },
  { key: "commandTimeoutSeconds", min: 10, max: 600, step: 10 },
];
const TOGGLES = [
  "useGpu",
  "autoContinue",
  "autoRunQueue",
  "showReasoning",
  "autoScroll",
] as const;
export function AgentSettings() {
  const t = useT();
  const [draft, setDraft] = useState(agent.options());
  const [manualContext, setManualContext] = useState(
    agent.options().contextTokens || 16_384,
  );
  const contextLimit =
    agent.getState().overview?.models.find(
      (model) => model.id === agent.getState().modelId,
    )?.contextTokens ?? 131_072;
  const [mode, setMode] = useState<AgentMode>(agent.getState().mode);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="agent-settings"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void Promise.all([
          agent.updateOptions(draft),
          agent.setMode(mode),
        ]).finally(() => {
          setSaving(false);
        });
      }}
    >
      <h3>{t("agent.settings.title")}</h3>
      <p>{t("agent.settings.scope")}</p>
      <InferenceModeToggle />
      <CloudSettingsSection />
      <label>
        {t("agent.settings.permissions")}
        <select
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as AgentMode);
          }}
        >
          {(["ask", "acceptEdits", "auto", "plan"] as const).map((value) => (
            <option key={value} value={value}>
              {t(`agent.mode.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <p>{t(`agent.settings.policy.${mode}`)}</p>
      <label>
        Execution effort
        <select
          value={draft.effort}
          onChange={(event) => {
            setDraft({
              ...draft,
              effort: event.target.value as AgentOptions["effort"],
            });
          }}
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </label>
      <label>
        {t("agent.settings.contextMode")}
        <select
          value={draft.contextTokens === 0 ? "auto" : "manual"}
          onChange={(event) => {
            setDraft({
              ...draft,
              contextTokens:
                event.target.value === "auto"
                  ? 0
                  : Math.min(Math.max(manualContext, 1_024), contextLimit),
            });
          }}
        >
          <option value="auto">{t("agent.settings.contextAuto")}</option>
          <option value="manual">{t("agent.settings.contextManual")}</option>
        </select>
      </label>
      {draft.contextTokens > 0 ? (
        <label>
          {t("agent.settings.contextTokens")}
          <input
            type="number"
            min={1024}
            max={contextLimit}
            step={1024}
            value={draft.contextTokens}
            onChange={(event) => {
              const value = Number(event.target.value);
              setManualContext(value);
              setDraft({ ...draft, contextTokens: value });
            }}
          />
        </label>
      ) : null}
      {NUMBERS.map(({ key, min, max, step }) => (
        <label key={key}>
          {t(`agent.settings.${key}`)}
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={Number(draft[key])}
            onChange={(event) => {
              setDraft({ ...draft, [key]: Number(event.target.value) });
            }}
          />
        </label>
      ))}
      <p>{t("agent.settings.contextHint")}</p>
      <p>{t("agent.settings.reasoningHint")}</p>
      <label>
        {t("agent.settings.afterEditCommand")}
        <input
          type="text"
          value={draft.afterEditCommand}
          placeholder="npm run lint"
          spellCheck={false}
          onChange={(event) => {
            setDraft({ ...draft, afterEditCommand: event.target.value });
          }}
        />
      </label>
      <p>{t("agent.settings.afterEditHint")}</p>
      <AgentCapabilities draft={draft} onChange={setDraft} />
      {TOGGLES.map((key) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={draft[key]}
            onChange={(event) => {
              setDraft({ ...draft, [key]: event.target.checked });
            }}
          />
          {t(`agent.settings.${key}`)}
        </label>
      ))}
      <button
        type="submit"
        className="button button--primary"
        disabled={saving}
      >
        {t("agent.settings.apply")}
      </button>
    </form>
  );
}
