import { agent } from "../../services/agent";
import { lastInterruptedTask, type TaskState } from "../../services/agent/agentTasks";
import { useT } from "../../i18n";

export function AgentQueue({ state }: { state: TaskState | undefined }) {
  const t = useT();
  if (!state || !state.tasks.length) return null;
  const pending = state.tasks.filter((task) => task.status === "pending");
  const interrupted = lastInterruptedTask(state.tasks);
  const active = state.tasks.find((task) => task.id === state.activeId);
  return <section className="agent-queue" aria-label={t("agent.tasks.title")}>
    <div className="agent-queue__actions">
      <span role="status">{t(state.paused ? "agent.tasks.paused" : "agent.tasks.title")} · {pending.length}</span>
      {pending.length ? <button type="button" onClick={() => { if (state.paused) agent.resumeQueue(); else agent.pauseQueue(); }}>{t(state.paused ? "agent.tasks.resume" : "agent.tasks.pause")}</button> : null}
      {!state.activeId && state.paused && interrupted ? <button type="button" title={interrupted.text} onClick={() => void agent.continueTask()}>{t("agent.tasks.continue")}</button> : null}
    </div>
    {active ? <div className="agent-queue__item"><span title={active.text}>{active.text}</span></div> : null}
    {pending.map((task) => <div className="agent-queue__item" key={task.id}>
      <span title={task.text}>{task.text}</span>
      <button type="button" aria-label={t("agent.tasks.cancel")} onClick={() => { agent.cancelTask(task.id); }}>×</button>
    </div>)}
  </section>;
}
