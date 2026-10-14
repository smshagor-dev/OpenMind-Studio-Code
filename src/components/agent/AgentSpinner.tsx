import { useEffect, useState } from "react";

import type { Phase } from "../../services/agent/agentModel";
import { formatElapsed, formatTokens } from "../../services/agent/agentModel";
import { useT } from "../../i18n";

/** The star that breathes while the agent works: the frames grow, then shrink back. */
const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const FRAME_MS = 120;
/** A new verb every few seconds keeps a long wait from looking frozen. */
const VERB_MS = 3_500;
const VERB_KEYS = [
  "agent.verb.thinking",
  "agent.verb.pondering",
  "agent.verb.working",
  "agent.verb.crafting",
  "agent.verb.reasoning",
  "agent.verb.brewing",
  "agent.verb.noodling",
  "agent.verb.computing",
];

function phaseKey(phase: Phase, verb: number): string {
  switch (phase) {
    case "loadingModel":
      return "agent.verb.loadingModel";
    case "waiting":
      return "agent.verb.waiting";
    case "tool":
      return "agent.verb.working";
    default:
      return VERB_KEYS[verb % VERB_KEYS.length] ?? "agent.verb.thinking";
  }
}

export function AgentSpinner({
  phase,
  startedAt,
  tokens,
}: {
  phase: Phase;
  startedAt: number | null;
  tokens: number;
}) {
  const t = useT();
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick((n) => n + 1);
      setNow(Date.now());
    }, FRAME_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const elapsed = startedAt === null ? 0 : Math.max(0, now - startedAt);
  const verb = Math.floor(elapsed / VERB_MS);
  const glyph = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  const parts = [formatElapsed(elapsed)];
  if (tokens > 0) parts.push(`↓ ${formatTokens(tokens)} ${t("agent.spinner.tokens")}`);
  parts.push(t("agent.spinner.interrupt"));
  return (
    <div className="agent-spinner" role="status" aria-live="polite">
      <span className="agent-spinner__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="agent-spinner__verb">{t(phaseKey(phase, verb))}…</span>
      <span className="agent-spinner__meta">({parts.join(" · ")})</span>
    </div>
  );
}
