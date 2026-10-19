import { useSyncExternalStore } from "react";

import { agent, starredChats } from "../../services/agent";
import type { HistorySummary } from "../../services/agent/agentHistory";
import { splitHistory } from "../../services/agent/agentStarred";
import { useT } from "../../i18n";

function HistoryRow({ item, starred }: { item: HistorySummary; starred: boolean }) {
  const t = useT();
  const starLabel = t(starred ? "agent.history.unstar" : "agent.history.star");
  return (
    <div className="agent-history__row">
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
        className={starred ? "agent-history__star agent-history__star--on" : "agent-history__star"}
        aria-label={starLabel}
        aria-pressed={starred}
        title={starLabel}
        onClick={() => {
          starredChats.toggle(item.id);
        }}
      >
        {starred ? "★" : "☆"}
      </button>
      <button
        type="button"
        aria-label={t("agent.history.delete")}
        onClick={() => {
          starredChats.remove(item.id);
          void agent.deleteHistory(item.id);
        }}
      >
        ×
      </button>
    </div>
  );
}

/** The header's star for the conversation on screen (shown once it has a message, so it is in the history). */
export function StarCurrentChat({ id, saved }: { id: string | undefined; saved: boolean }) {
  const t = useT();
  useSyncExternalStore(
    (listener) => starredChats.subscribe(listener),
    () => starredChats.getVersion(),
  );
  if (!id || !saved) return null;
  const starred = starredChats.has(id);
  const label = t(starred ? "agent.history.unstarCurrent" : "agent.history.starCurrent");
  return (
    <button
      type="button"
      className={starred ? "agent-icon-button agent-history__star--on" : "agent-icon-button"}
      aria-label={label}
      aria-pressed={starred}
      title={label}
      onClick={() => {
        starredChats.toggle(id);
      }}
    >
      {starred ? "★" : "☆"}
    </button>
  );
}

export function AgentHistoryView({ items }: { items: HistorySummary[] }) {
  const t = useT();
  useSyncExternalStore(
    (listener) => starredChats.subscribe(listener),
    () => starredChats.getVersion(),
  );
  const { starred, recent } = splitHistory(items, starredChats.list());
  return (
    <section className="agent-history" aria-label={t("agent.history.title")}>
      <h3>{t("agent.history.title")}</h3>
      {!items.length ? <p>{t("agent.history.empty")}</p> : null}
      {starred.length ? (
        <>
          <h4 className="agent-history__group">{t("agent.history.starred")}</h4>
          {starred.map((item) => (
            <HistoryRow key={item.id} item={item} starred />
          ))}
          {recent.length ? (
            <h4 className="agent-history__group">{t("agent.history.recent")}</h4>
          ) : null}
        </>
      ) : null}
      {recent.map((item) => (
        <HistoryRow key={item.id} item={item} starred={false} />
      ))}
    </section>
  );
}
