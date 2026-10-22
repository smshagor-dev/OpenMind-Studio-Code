import { AgentCapabilities } from "./AgentCapabilities";
import { useState, useSyncExternalStore } from "react";
import { agent } from "../../services/agent";
import type { AgentMode } from "../../services/agent/agentIpc";
import type { AgentOptions } from "../../services/agent/agentOptions";
import { useT } from "../../i18n";
import { LocalSection, CloudSetup } from "./AgentSetup";

/** The Online/Offline tabs, showing the exact same model pickers as the Agent Setup dialog (the model chip /
 * "Configure now") -- the gear icon used to show a different, cut-down summary with one generic "Use"
 * button instead of letting you pick a specific edition or cloud model, which is what "the Use button does
 * nothing useful" actually was: there was nothing to pick. The Online tab additionally carries the Cloud
 * connection form (address/key/test), which only belongs in Settings. */
function InferenceTabs() {
  const t = useT();
  // Subscribed live (unlike the rest of this form, which only reads agent.getState() once at mount):
  // saving a key in CloudSettingsSection below must enable the matching "Use" button right away, without
  // the user having to close and reopen Agent Settings.
  const state = useSyncExternalStore((listener) => agent.subscribe(listener), () => agent.getState());
  const [tab, setTab] = useState<"offline" | "online">(agent.inferenceMode() === "cloud" ? "online" : "offline");
  const [switching, setSwitching] = useState(false);
  const activeMode = agent.inferenceMode();
  const switchMode = async (mode: "local" | "cloud") => {
    if (switching || mode === activeMode) return;
    setSwitching(true);
    try {
      if (mode === "cloud" && !state.cloud) await agent.loadCloudStatus();
      await agent.toggleInference(mode);
      setTab(mode === "local" ? "offline" : "online");
    } finally {
      setSwitching(false);
    }
  };
  return (
    <div className="agent-inference-tabs">
      <div role="group" aria-label="Active AI provider" className="agent-setup-tabs">
        <button type="button" className="agent-setup-tab" aria-pressed={activeMode === "local"} disabled={switching}
          onClick={() => { void switchMode("local"); }}>Local {activeMode === "local" ? "✓" : ""}</button>
        <button type="button" className="agent-setup-tab" aria-pressed={activeMode === "cloud"} disabled={switching}
          onClick={() => { void switchMode("cloud"); }}>Cloud {activeMode === "cloud" ? "✓" : ""}</button>
      </div>
      <p className="agent-model__progress-text">Active: {activeMode === "local" ? "Local AI" : "OpenMind Cloud"} · Choose which assistant handles requests.</p>
      <div className="agent-setup-tabs" role="tablist" aria-label={t("agent.inference.title")}>
        <button type="button" role="tab" className="agent-setup-tab" aria-selected={tab === "offline"}
          onClick={() => { setTab("offline"); }}>
          {t("agent.inference.tabOffline")}
        </button>
        <button type="button" role="tab" className="agent-setup-tab" aria-selected={tab === "online"}
          onClick={() => { setTab("online"); if (!state.cloud) void agent.loadCloudStatus(); }}>
          {t("agent.inference.tabOnline")}
        </button>
      </div>
      {tab === "offline" ? (
        <div role="tabpanel">
          {state.overview ? (
            <LocalSection overview={state.overview} downloads={state.downloads} modelId={state.modelId} installing={state.installingEngine} />
          ) : (
            <p className="agent-model__progress-text">{t("agent.loading")}</p>
          )}
        </div>
      ) : (
        <div role="tabpanel">
          <CloudSetup cloud={state.cloud} modelId={state.modelId} />
        </div>
      )}
    </div>
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
      <InferenceTabs />
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
