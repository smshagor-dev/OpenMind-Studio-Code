import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { Decision, PermissionRequest } from "../../services/agent/agentIpc";
import { useT } from "../../i18n";
import { AgentDiff } from "./AgentDiff";

/** Fetching a web page and moving a file get their own words; everything else follows the tool's kind. */
function variant(request: PermissionRequest): string {
  if (request.kind === "command" && request.title === "Fetch") return "Fetch";
  if (request.kind === "command") return "Command";
  if (request.kind === "delete") return "Delete";
  if (request.title === "Move") return "Move";
  return request.title === "Create" ? "Create" : "Edit";
}

function headingKey(request: PermissionRequest): string {
  return `agent.permission.heading${variant(request)}`;
}

function questionKey(request: PermissionRequest): string {
  return `agent.permission.ask${variant(request)}`;
}

function sessionKey(request: PermissionRequest): string {
  if (variant(request) === "Fetch") return "agent.permission.sessionFetch";
  switch (request.kind) {
    case "command":
      return "agent.permission.sessionCommand";
    case "delete":
      return "agent.permission.sessionDelete";
    default:
      return "agent.permission.sessionEdit";
  }
}

/** The question before a change or a command: the exact change, then Yes / Yes for the session / No. */
export function AgentPermission({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  onAnswer: (decision: Decision) => void;
}) {
  const t = useT();
  const [choice, setChoice] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, [request.id]);

  const options = [t("agent.permission.yes"), t(sessionKey(request)), t("agent.permission.no")];
  const pick = (index: number) => {
    if (index === 0) onAnswer({ decision: "allow" });
    else if (index === 1) onAnswer({ decision: "allowSession" });
    else setFeedback("");
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (feedback !== null) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setChoice((c) => (c + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(choice);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onAnswer({ decision: "deny", feedback: null });
    } else if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      pick(1);
    } else if (/^[123]$/.test(event.key)) {
      event.preventDefault();
      pick(Number(event.key) - 1);
    }
  };

  return (
    <div
      ref={box}
      className="agent-permission agent-enter"
      role="dialog"
      aria-label={t(headingKey(request))}
      tabIndex={0}
      onKeyDown={onKey}
    >
      <div className="agent-permission__heading">{t(headingKey(request))}</div>
      {request.kind === "command" ? (
        <pre className="agent-permission__command">{request.target}</pre>
      ) : (
        <div className="agent-permission__file">{request.target}</div>
      )}
      {request.diff && request.diff.lines.length > 0 ? <AgentDiff diff={request.diff} startOpen /> : null}
      <div className="agent-permission__question">{t(questionKey(request), { target: request.target })}</div>
      {feedback === null ? (
        <div className="agent-permission__options" role="listbox" aria-label={t(questionKey(request), { target: "" })}>
          {options.map((label, index) => (
            <button
              key={label}
              type="button"
              role="option"
              aria-selected={choice === index}
              className={
                choice === index
                  ? "agent-permission__option agent-permission__option--active"
                  : "agent-permission__option"
              }
              onMouseEnter={() => {
                setChoice(index);
              }}
              onClick={() => {
                pick(index);
              }}
            >
              <span className="agent-permission__cursor" aria-hidden="true">
                {choice === index ? "❯" : " "}
              </span>
              <span className="agent-permission__number">{index + 1}.</span>
              <span>{label}</span>
              {index === 1 ? <span className="agent-permission__hint">(shift+tab)</span> : null}
              {index === 2 ? <span className="agent-permission__hint">(esc)</span> : null}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="agent-permission__feedback"
          onSubmit={(event) => {
            event.preventDefault();
            onAnswer({ decision: "deny", feedback: feedback.trim() || null });
          }}
        >
          <input
            ref={(element) => {
              element?.focus();
            }}
            className="agent-input"
            value={feedback}
            placeholder={t("agent.permission.feedbackPlaceholder")}
            aria-label={t("agent.permission.feedbackPlaceholder")}
            onChange={(event) => {
              setFeedback(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onAnswer({ decision: "deny", feedback: null });
            }}
          />
          <button type="submit" className="button button--primary">
            {t("agent.permission.sendFeedback")}
          </button>
        </form>
      )}
    </div>
  );
}
