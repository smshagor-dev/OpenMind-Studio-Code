import { agent } from "../../services/agent";
import type { HistorySummary } from "../../services/agent/agentHistory";
import { useT } from "../../i18n";
export function AgentHistoryView({ items }: { items: HistorySummary[] }) {
  const t = useT();
  return (
    <section className="agent-history" aria-label={t("agent.history.title")}>
      <h3>{t("agent.history.title")}</h3>
      {!items.length ? <p>{t("agent.history.empty")}</p> : null}
      {items.map((item) => (
        <div className="agent-history__row" key={item.id}>
          <button
            type="button"
            title={item.providerId}
            onClick={() => void agent.restoreHistory(item.id)}
          >
            {item.title}
            <small>{new Date(item.updatedAt).toLocaleString()}</small>
          </button>
          <button
            type="button"
            aria-label={t("agent.history.delete")}
            onClick={() => void agent.deleteHistory(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </section>
  );
}
