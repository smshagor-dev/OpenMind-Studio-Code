import { agent } from "../../services/agent";
import { useT } from "../../i18n";

/** The agent's background commands (servers, watchers) still running, each with a Stop button. */
export function AgentBackground({ jobs }: { jobs: { id: string; command: string }[] | undefined }) {
  const t = useT();
  if (!jobs || !jobs.length) return null;
  return (
    <section className="agent-background" aria-label={t("agent.background.title")}>
      <span className="agent-background__title">{t("agent.background.title")}</span>
      {jobs.map((job) => (
        <div className="agent-background__job" key={job.id}>
          <span className="agent-background__dot" aria-hidden="true">●</span>
          <span className="agent-background__command" title={job.command}>
            {job.id} {job.command}
          </span>
          <button
            type="button"
            className="agent-background__stop"
            aria-label={t("agent.background.stop", { id: job.id })}
            onClick={() => void agent.killBackground(job.id)}
          >
            ■
          </button>
        </div>
      ))}
    </section>
  );
}
