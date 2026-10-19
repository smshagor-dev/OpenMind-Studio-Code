import { agent } from "../../services/agent";
import type { AgentTab } from "../../services/agent/agentTabs";
import { useT } from "../../i18n";

/** Conversation tabs above the transcript; shown once there is more than one conversation. */
export function AgentTabsBar({ tabs, current, busy }: { tabs: AgentTab[] | undefined; current: string | undefined; busy: boolean }) {
  const t = useT();
  if (!tabs || tabs.length < 2) return null;
  const blocked = busy ? t("agent.tabs.busy") : undefined;
  return (
    <div className="agent-tabs" role="tablist" aria-label={t("agent.tabs.title")}>
      {tabs.map((tab) => {
        const active = tab.id === current;
        const title = tab.title || t("agent.tabs.new");
        return (
          <div key={tab.id} className={active ? "agent-tab agent-tab--active" : "agent-tab"}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="agent-tab__title"
              title={active ? title : (blocked ?? title)}
              disabled={!active && busy}
              onClick={() => void agent.tabs.switchTo(tab.id)}
            >
              {title}
            </button>
            <button
              type="button"
              className="agent-tab__close"
              aria-label={t("agent.tabs.close", { title })}
              title={active && blocked ? blocked : t("agent.tabs.close", { title })}
              disabled={active && busy}
              onClick={() => void agent.tabs.close(tab.id)}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="agent-tab__new"
        aria-label={t("agent.tabs.open")}
        title={blocked ?? t("agent.tabs.open")}
        disabled={busy}
        onClick={() => void agent.tabs.open()}
      >
        +
      </button>
    </div>
  );
}
