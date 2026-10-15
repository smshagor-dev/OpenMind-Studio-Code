import { useState } from "react";

import type { FileDiff } from "../../services/agent/agentIpc";
import { useT } from "../../i18n";

/** Lines shown before "Show all" (a long diff stays readable in a narrow panel). */
const COLLAPSED_LINES = 14;

/** A change as Claude Code shows it: line numbers, `-`/`+` marks, red and green lines, gaps between hunks. */
export function AgentDiff({ diff, startOpen = false }: { diff: FileDiff; startOpen?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(startOpen);
  const lines = open ? diff.lines : diff.lines.slice(0, COLLAPSED_LINES);
  const hidden = diff.lines.length - lines.length;
  return (
    <div className="agent-diff" role="figure" aria-label={t("agent.diff.label", { added: diff.added, removed: diff.removed })}>
      {lines.map((line, index) =>
        line.kind === "gap" ? (
          <div key={index} className="agent-diff__gap" aria-hidden="true">
            ⋮
          </div>
        ) : (
          <div key={index} className={`agent-diff__line agent-diff__line--${line.kind}`}>
            <span className="agent-diff__number">{line.kind === "removed" ? line.oldLine : line.newLine}</span>
            <span className="agent-diff__mark" aria-hidden="true">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
            </span>
            <span className="agent-diff__text">{line.text || " "}</span>
          </div>
        ),
      )}
      {hidden > 0 || diff.truncated ? (
        <button
          type="button"
          className="agent-diff__more"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? t("agent.diff.less") : t("agent.diff.more", { count: hidden })}
        </button>
      ) : null}
    </div>
  );
}
