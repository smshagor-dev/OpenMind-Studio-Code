import { useState } from "react";

import type { Entry } from "../../services/agent/agentModel";
import { agent } from "../../services/agent";
import { container } from "../../services/container";
import { useT } from "../../i18n";
import { MarkdownText } from "../MarkdownPreview";
import { AgentDiff } from "./AgentDiff";

type ToolEntry = Extract<Entry, { kind: "tool" }>;

/** Lines of command output shown before "Show more". */
const PREVIEW_LINES = 6;

function openLink(href: string): void {
  if (/^https?:\/\//i.test(href)) void container.ipc.openExternalUrl(href);
  else agent.openFile(href);
}

export function AgentWelcome({ folder }: { folder: string | null }) {
  const t = useT();
  return (
    <div className="agent-welcome agent-enter">
      <div className="agent-welcome__box">
        <div className="agent-welcome__title">
          <span className="agent-welcome__star" aria-hidden="true">
            ✻
          </span>
          {t("agent.welcome.title")}
        </div>
        <div className="agent-welcome__cwd">{folder ?? t("agent.welcome.noFolder")}</div>
      </div>
      <div className="agent-welcome__tips">
        <div className="agent-welcome__tips-title">{t("agent.welcome.tipsTitle")}</div>
        <ol>
          <li>{t("agent.welcome.tip1")}</li>
          <li>{t("agent.welcome.tip2")}</li>
          <li>{t("agent.welcome.tip3")}</li>
          <li>{t("agent.welcome.tip4")}</li>
        </ol>
      </div>
    </div>
  );
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-reasoning">
      <button
        type="button"
        className="agent-reasoning__toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span aria-hidden="true">∴</span> {live ? t("agent.reasoning.live") : t("agent.reasoning.done")}
        <span className="agent-reasoning__chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? <div className="agent-reasoning__text">{text.trim()}</div> : null}
    </div>
  );
}

function Assistant({ entry, live, showReasoning }: { entry: Extract<Entry, { kind: "assistant" }>; live: boolean; showReasoning: boolean }) {
  return (
    <div className="agent-message agent-message--assistant agent-enter">
      {showReasoning && entry.reasoning.trim() ? <Reasoning text={entry.reasoning} live={live && !entry.text} /> : null}
      {entry.text.trim() ? (
        <div className="agent-message__row">
          <span className="agent-dot agent-dot--text" aria-hidden="true">
            ●
          </span>
          <div className="agent-message__body">
            <MarkdownText text={entry.text} onLink={openLink} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function toolLabel(t: (key: string) => string, title: string): string {
  const key = `agent.tool.${title.replace(/\s+/g, "")}`;
  const label = t(key);
  return label === key ? title : label;
}

function Preview({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const shown = open ? lines : lines.slice(0, PREVIEW_LINES);
  return (
    <div className="agent-tool__preview">
      <pre>{shown.join("\n")}</pre>
      {lines.length > PREVIEW_LINES ? (
        <button
          type="button"
          className="agent-tool__more"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? t("agent.diff.less") : t("agent.tool.moreLines", { count: lines.length - PREVIEW_LINES })}
        </button>
      ) : null}
    </div>
  );
}

function ToolCard({ entry }: { entry: ToolEntry }) {
  const t = useT();
  const showPreview = entry.preview && (entry.toolKind === "command" || entry.status === "failed");
  const summary =
    entry.status === "declined"
      ? t("agent.tool.declined")
      : entry.status === "waiting"
        ? t("agent.tool.waiting")
        : entry.summary;
  return (
    <div className={`agent-tool agent-tool--${entry.status} agent-enter`}>
      <div className="agent-tool__head">
        <span className={`agent-dot agent-dot--${entry.status}`} aria-hidden="true">
          ●
        </span>
        <span className="agent-tool__title">{toolLabel(t, entry.title)}</span>
        {entry.target ? (
          entry.changedPath && entry.toolKind === "edit" ? (
            <button
              type="button"
              className="agent-tool__target agent-tool__target--link"
              title={t("agent.tool.openFile")}
              onClick={() => {
                agent.openFile(entry.changedPath ?? "");
              }}
            >
              ({entry.target})
            </button>
          ) : (
            <span className="agent-tool__target">({entry.target})</span>
          )
        ) : null}
      </div>
      {summary ? (
        <div className="agent-tool__result">
          <span className="agent-tool__elbow" aria-hidden="true">
            ⎿
          </span>
          <span>{summary}</span>
        </div>
      ) : null}
      {entry.diff && entry.status !== "declined" && entry.diff.lines.length > 0 ? (
        <div className="agent-tool__nested">
          <AgentDiff diff={entry.diff} />
        </div>
      ) : null}
      {showPreview ? (
        <div className="agent-tool__nested">
          <Preview text={entry.preview} />
        </div>
      ) : null}
    </div>
  );
}

export function AgentTranscript({ entries, busy, showReasoning = true }: { entries: Entry[]; busy: boolean; showReasoning?: boolean }) {
  const last = entries[entries.length - 1];
  return (
    <>
      {entries.map((entry) => {
        switch (entry.kind) {
          case "document":
            return <details key={entry.id} className="agent-document"><summary>{entry.name}</summary><pre>{entry.text}</pre></details>;
          case "asset":
            return <figure key={entry.id} className="agent-asset"><img src={entry.data} alt={entry.name} loading="lazy" /><figcaption>{entry.name} <a href={entry.data} download={entry.name}>↓</a></figcaption></figure>;
          case "user":
            return (
              <div key={entry.id} className="agent-message agent-message--user agent-enter">
                <span className="agent-message__prompt" aria-hidden="true">
                  &gt;
                </span>
                <div className="agent-message__user-text">{entry.text}</div>
              </div>
            );
          case "assistant":
            return <Assistant showReasoning={showReasoning} key={entry.id} entry={entry} live={busy && entry === last} />;
          case "tool":
            return <ToolCard key={entry.id} entry={entry} />;
          case "notice":
            return (
              <div key={entry.id} className={`agent-notice agent-notice--${entry.tone} agent-enter`}>
                <span className="agent-tool__elbow" aria-hidden="true">
                  ⎿
                </span>
                <span>{entry.text}</span>
              </div>
            );
        }
      })}
    </>
  );
}
