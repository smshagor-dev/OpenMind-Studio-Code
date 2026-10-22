import { useState, useSyncExternalStore } from "react";
import { agent } from "../../services/agent";
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

/** Model selection and Cloud connection only. Runtime tuning is automatic. */
export function AgentSettings() {
  const t = useT();
  return (
    <div className="agent-settings">
      <h3>{t("agent.settings.title")}</h3>
      <InferenceTabs />
    </div>
  );
}
