import { useSyncExternalStore } from "react";
import { agent } from "../../services/agent";
import { useT } from "../../i18n";
import { LocalSection } from "./AgentSetup";

/** The coding assistant is local-only. Cloud credentials live under AI Providers. */
export function AgentSettings() {
  const t = useT();
  const state = useSyncExternalStore((listener) => agent.subscribe(listener), () => agent.getState());
  return (
    <div className="agent-settings" style={{ width: "100%", maxWidth: 760, margin: "0 auto", minWidth: 0 }}>
      <header style={{ marginBottom: 20 }}>
        <h3 style={{ margin: "0 0 6px", fontSize: 21 }}>{t("agent.settings.title")}</h3>
        <p className="agent-model__progress-text" style={{ margin: 0 }}>
          Local AI runs on this computer. Performance settings are automatic.
          Configure OpenMindAI Cloud separately in Settings → AI Providers.
        </p>
      </header>
      {state.overview ? (
        <LocalSection overview={state.overview} downloads={state.downloads}
          modelId={state.modelId} installing={state.installingEngine} />
      ) : <p className="agent-model__progress-text">{t("agent.loading")}</p>}
    </div>
  );
}
