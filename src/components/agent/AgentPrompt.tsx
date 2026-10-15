import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { AgentMode } from "../../services/agent/agentIpc";
import { completeMention, mentionQuery } from "../../services/agent/agentModel";
import { agent } from "../../services/agent";
import { useT } from "../../i18n";

interface SlashCommand {
  name: string;
  key: string;
  run: () => void;
}

function slashCommands(): SlashCommand[] {
  return [
    { name: "/settings", key: "agent.settings.title", run: () => { agent.openSettings(true); } },
    { name: "/resume", key: "agent.tasks.resume", run: () => { agent.resumeQueue(); } },
    { name: "/pause", key: "agent.tasks.pause", run: () => { agent.pauseQueue(); } },
    { name: "/continue", key: "agent.tasks.continue", run: () => void agent.continueTask() },
    { name: "/clear", key: "agent.slash.clear", run: () => void agent.newChat() },
    { name: "/undo", key: "agent.slash.undo", run: () => void agent.undo() },
    { name: "/models", key: "agent.slash.models", run: () => { agent.openSetup(true); } },
    { name: "/plan", key: "agent.slash.plan", run: () => void agent.setMode("plan") },
    { name: "/stop", key: "agent.slash.stop", run: () => void agent.stop() },
  ];
}

function ModeLine({ mode, contextShare }: { mode: AgentMode; contextShare: number | null }) {
  const t = useT();
  return (
    <div className="agent-prompt__status">
      <button
        type="button"
        className={`agent-mode agent-mode--${mode}`}
        title={t("agent.mode.cycle")}
        onClick={() => void agent.cycleMode()}
      >
        {mode === "acceptEdits" ? (
          <>
            <span aria-hidden="true">⏵⏵</span> {t("agent.mode.acceptEdits")}
          </>
        ) : mode === "plan" ? (
          <>
            <span aria-hidden="true">⏸</span> {t("agent.mode.plan")}
          </>
        ) : (
          t(`agent.mode.${mode}`)
        )}
        <span className="agent-mode__hint">{t("agent.mode.shiftTab")}</span>
      </button>
      {contextShare !== null ? (
        <span className="agent-prompt__context" title={t("agent.context.title")}>
          {t("agent.context.used", { percent: contextShare })}
        </span>
      ) : null}
    </div>
  );
}

export function AgentPrompt({
  mode,
  busy,
  disabledReason,
  contextShare,
}: {
  mode: AgentMode;
  busy: boolean;
  disabledReason: string | null;
  contextShare: number | null;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);

  const mention = mentionQuery(text, caret);
  const slash = text.startsWith("/") && !text.includes(" ") ? slashCommands().filter((c) => c.name.startsWith(text)) : [];
  useEffect(() => {
    if (mention === null) return;
    let live = true;
    void agent.suggestFiles(mention).then((found) => {
      if (live) setFiles(found);
    });
    return () => {
      live = false;
    };
  }, [mention]);
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  const shownFiles = mention === null ? [] : files;
  const menu = slash.length > 0 ? slash.map((c) => c.name) : shownFiles;
  const choose = (index: number) => {
    if (slash.length > 0) {
      slash[index]?.run();
      setText("");
      return;
    }
    const path = shownFiles[index];
    if (!path) return;
    const next = completeMention(text, caret, path);
    setText(next.text);
    setCaret(next.caret);
    window.requestAnimationFrame(() => area.current?.setSelectionRange(next.caret, next.caret));
  };
  const submit = async () => {
    if (disabledReason || !text.trim()) return;
    const sent = await agent.send(text);
    if (sent) setText("");
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setMenuIndex((i) => (i + (event.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length);
      return;
    }
    if (menu.length > 0 && (event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
      event.preventDefault();
      choose(Math.min(menuIndex, menu.length - 1));
      return;
    }
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      void agent.cycleMode();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && busy) {
      event.preventDefault();
      void agent.stop();
    }
  };

  return (
    <div className="agent-prompt">
      {menu.length > 0 ? (
        <div className="agent-prompt__menu" role="listbox" aria-label={t("agent.prompt.suggestions")}>
          {menu.map((item, index) => (
            <button
              key={item}
              type="button"
              role="option"
              aria-selected={index === menuIndex}
              className={index === menuIndex ? "agent-prompt__item agent-prompt__item--active" : "agent-prompt__item"}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(index);
              }}
            >
              <span className="agent-prompt__item-name">{item}</span>
              {slash[index] ? <span className="agent-prompt__item-hint">{t(slash[index].key)}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className={busy ? "agent-prompt__box agent-prompt__box--busy" : "agent-prompt__box"}>
        <span className="agent-prompt__glyph" aria-hidden="true">
          &gt;
        </span>
        <textarea
          ref={area}
          className="agent-prompt__input"
          rows={1}
          value={text}
          spellCheck={false}
          placeholder={disabledReason ?? t("agent.prompt.placeholder")}
          aria-label={t("agent.prompt.label")}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setMenuIndex(0);
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart);
          }}
          onKeyDown={onKey}
        />
      </div>
      <div className="agent-queue__actions">
        <button type="button" disabled={!!disabledReason || !text.trim()} onClick={() => void submit()}>{t(busy ? "agent.tasks.queue" : "agent.tasks.send")}</button>
        {busy ? <button type="button" onClick={() => void agent.stop()}>{t("agent.tasks.stop")}</button> : null}
      </div>
      <ModeLine mode={mode} contextShare={contextShare} />
    </div>
  );
}
