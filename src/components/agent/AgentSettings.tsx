import { AgentCapabilities } from "./AgentCapabilities";
import { useState } from "react";
import { agent } from "../../services/agent";
import type { AgentMode } from "../../services/agent/agentIpc";
import type { AgentOptions } from "../../services/agent/agentOptions";
import { useT } from "../../i18n";

const NUMBERS: {
  key: keyof AgentOptions;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "contextTokens", min: 0, max: 131072, step: 1024 },
  { key: "maxOutputTokens", min: 1024, max: 32768, step: 1024 },
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
      {NUMBERS.map(({ key, min, max, step }) => (
        <label key={key}>
          {t(`agent.settings.${key}`)}
          <input
            type="number"
            min={min}
            max={
              key === "contextTokens"
                ? (agent
                    .getState()
                    .overview?.models.find(
                      (m) => m.id === agent.getState().modelId,
                    )?.contextTokens ?? max)
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
