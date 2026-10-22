import { useState, useSyncExternalStore } from "react";
import { agent } from "../../services/agent";
import { useT } from "../../i18n";
import { LocalSection, CloudSetup } from "./AgentSetup";

/** A single provider selector; inspecting a provider never changes the active model. */
function InferenceTabs() {
  const t = useT();
  const state = useSyncExternalStore((listener) => agent.subscribe(listener), () => agent.getState());
  const activeMode = agent.inferenceMode();
  const [tab, setTab] = useState<"local" | "cloud">(activeMode);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectProvider = async (mode: "local" | "cloud") => {
    setTab(mode);
    setError(null);
    if (switching || mode === activeMode) return;
    setSwitching(true);
    try {
      if (mode === "cloud" && !state.cloud) await agent.loadCloudStatus();
      await agent.toggleInference(mode);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="agent-inference-tabs" style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ fontWeight: 650, fontSize: 14 }}>Where the assistant runs</div>
        <div className="agent-setup-tabs" role="tablist" aria-label={t("agent.inference.title")}
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", padding: 4, gap: 4, borderRadius: 12, background: "var(--surface-secondary, rgba(127,127,127,.10))" }}>
          {(["local", "cloud"] as const).map((mode) => (
            <button key={mode} type="button" role="tab" aria-selected={tab === mode}
              disabled={switching}
              className="agent-setup-tab"
              style={{ borderRadius: 9, padding: "12px 16px", fontWeight: tab === mode ? 700 : 500,
                border: tab === mode ? "1px solid var(--border-color, rgba(127,127,127,.35))" : "1px solid transparent",
                background: tab === mode ? "var(--surface-primary, rgba(127,127,127,.18))" : "transparent" }}
              onClick={() => { void selectProvider(mode); }}>
              {mode === "local" ? "Local AI" : "OpenMind Cloud"}
              {activeMode === mode ? "  ✓" : ""}
            </button>
          ))}
        </div>
        <p className="agent-model__progress-text" style={{ margin: 0 }}>
          {switching ? "Switching assistant…" : activeMode === "local"
            ? "Local AI is active · Runs on this computer"
            : "OpenMind Cloud is selected · Uses your cloud connection"}
        </p>
        {error ? <p role="alert" className="agent-model__error">{error}</p> : null}
      </div>
      <section role="tabpanel" style={{ border: "1px solid var(--border-color, rgba(127,127,127,.22))",
        borderRadius: 14, padding: "clamp(14px, 3vw, 24px)", minWidth: 0 }}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{tab === "local" ? "Local AI" : "OpenMind Cloud"}</div>
          <p className="agent-model__progress-text" style={{ margin: "6px 0 0" }}>
            {tab === "local" ? "Install a model once. Performance is configured automatically for your PC."
              : "Connect your account and choose a cloud model. Performance settings are automatic."}
          </p>
        </div>
        {tab === "local" ? (
          state.overview ? (
            <LocalSection overview={state.overview} downloads={state.downloads} modelId={state.modelId}
              installing={state.installingEngine} />
          ) : <p className="agent-model__progress-text">{t("agent.loading")}</p>
        ) : <CloudSetup cloud={state.cloud} modelId={state.modelId} />}
      </section>
    </div>
  );
}

export function AgentSettings() {
  const t = useT();
  return (
    <div className="agent-settings" style={{ width: "100%", maxWidth: 760, margin: "0 auto", minWidth: 0 }}>
      <header style={{ marginBottom: 20 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 21 }}>{t("agent.settings.title")}</h3>
        <p className="agent-model__progress-text" style={{ margin: 0 }}>
          Select your assistant. Everything else is configured automatically.
        </p>
      </header>
      <InferenceTabs />
    </div>
  );
}
