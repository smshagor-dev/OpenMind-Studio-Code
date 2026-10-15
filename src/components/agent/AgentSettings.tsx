import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { agent } from "../../services/agent";
import type { AgentMode } from "../../services/agent/agentIpc";
import type { AgentOptions } from "../../services/agent/agentOptions";
import { useT } from "../../i18n";

const NUMBERS: { key: keyof AgentOptions; min: number; max: number; step: number }[] = [
  { key: "contextTokens", min: 0, max: 131072, step: 1024 },
  { key: "maxOutputTokens", min: 1024, max: 32768, step: 1024 },
  { key: "maxSteps", min: 8, max: 512, step: 1 },
  { key: "maxContinuations", min: 0, max: 16, step: 1 },
  { key: "temperature", min: 0, max: 1, step: 0.1 },
  { key: "commandTimeoutSeconds", min: 10, max: 600, step: 10 },
];
const TOGGLES = ["useGpu", "autoContinue", "autoRunQueue", "showReasoning", "autoScroll"] as const;
export function AgentSettings() {
  const t = useT();
  const [draft, setDraft] = useState(agent.options());
  const [mode, setMode] = useState<AgentMode>(agent.getState().mode);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string[]>([]);
  return (
    <form
      className="agent-settings"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void Promise.all([agent.updateOptions(draft), agent.setMode(mode)]).finally(() => {
          setSaving(false);
        });
      }}
    >
      <h3>{t("agent.settings.title")}</h3>
      <p>{t("agent.settings.scope")}</p>
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
      {NUMBERS.map(({ key, min, max, step }) => (
        <label key={key}>
          {t(`agent.settings.${key}`)}
          <input
            type="number"
            min={min}
            max={
              key === "contextTokens"
                ? (agent.getState().overview?.models.find((m) => m.id === agent.getState().modelId)
                    ?.contextTokens ?? max)
                : max
            }
            step={step}
            value={Number(draft[key])}
            onChange={(event) => {
              setDraft({ ...draft, [key]: Number(event.target.value) });
            }}
          />
        </label>
      ))}
      <p>{t("agent.settings.contextHint")}</p>
      <p>{t("agent.capabilities.hint")}</p>
      {(["searchEndpoint", "visionEndpoint", "imageEndpoint"] as const).map((key) => (
        <label key={key}>
          {t(`agent.settings.${key}`)}
          <input
            type="url"
            value={draft[key]}
            placeholder={
              key === "searchEndpoint"
                ? "https://search.example.org"
                : key === "visionEndpoint"
                  ? "http://127.0.0.1:8081/v1"
                  : "http://127.0.0.1:7860"
            }
            onChange={(event) => {
              setDraft({ ...draft, [key]: event.target.value });
            }}
          />
        </label>
      ))}
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
        type="button"
        disabled={checking}
        onClick={() => {
          setChecking(true);
          void invoke<string[]>("agent_capabilities_check", { options: draft })
            .then(setStatus)
            .catch((error: unknown) => {
              setStatus([String(error)]);
            })
            .finally(() => {
              setChecking(false);
            });
        }}
      >
        {checking ? t("agent.loading") : t("agent.capabilities.check")}
      </button>
      <div role="status">
        {status.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <button type="submit" className="button button--primary" disabled={saving}>
        {t("agent.settings.apply")}
      </button>
    </form>
  );
}
