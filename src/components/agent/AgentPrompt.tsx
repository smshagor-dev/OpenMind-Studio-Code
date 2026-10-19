import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import type { AgentMode } from "../../services/agent/agentIpc";
import { completeMention, mentionQuery } from "../../services/agent/agentModel";
import { agent } from "../../services/agent";
import {
  AGENT_COMMANDS,
  matchingCommands,
} from "../../services/agent/agentCommands";
import { AttachButton, AttachmentChips } from "./AgentAttachments";
import { useT } from "../../i18n";

const MODE_ICONS: Record<AgentMode, string> = { ask: "◇", acceptEdits: "⏵⏵", auto: "»", plan: "⏸" };

/** The permission mode, bottom left of the composer as in Claude Code (click or Shift+Tab cycles it). */
function ModeButton({ mode }: { mode: AgentMode }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`agent-mode agent-mode--${mode}`}
      title={t("agent.mode.cycle")}
      onClick={() => void agent.cycleMode()}
    >
      <span className="agent-mode__icon" aria-hidden="true">
        {MODE_ICONS[mode]}
      </span>
      <span>{t(`agent.mode.${mode}`)}</span>
    </button>
  );
}

/** The editor's front file, named to the agent with the message; a click leaves it out (Claude Code's file chip). */
function ActiveFileChip({ path, included }: { path: string; included: boolean }) {
  const t = useT();
  const name = path.split("/").pop() ?? path;
  return (
    <button
      type="button"
      className={included ? "agent-chip agent-chip--file" : "agent-chip agent-chip--file agent-chip--off"}
      aria-pressed={included}
      title={t(included ? "agent.composer.fileIncluded" : "agent.composer.fileExcluded", { path })}
      onClick={() => {
        agent.toggleActiveFile();
      }}
    >
      <span aria-hidden="true">{included ? "◉" : "○"}</span>
      <span className="agent-chip__name">{name}</span>
    </button>
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
  const agentState = useSyncExternalStore(
    (listener) => agent.subscribe(listener),
    () => agent.getState(),
  );
  const activeFile = agentState.activeFile ?? null;
  const includeFile = agentState.includeActiveFile !== false;
  const attachments = agentState.attachments?.length ?? 0;
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [menuIndex, setMenuIndex] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [commandMenu, setCommandMenu] = useState(false);
  const menuId = useId();

  const mention = mentionQuery(text, caret);
  const slash =
    !dismissed && (commandMenu || (text.startsWith("/") && !/\s/.test(text)))
      ? commandMenu
        ? [...AGENT_COMMANDS]
        : matchingCommands(text)
      : [];
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
    element.style.height = `${Math.max(60, Math.min(element.scrollHeight, 260))}px`;
  }, [text]);

  const shownFiles = dismissed || mention === null ? [] : files;
  const menu = slash.length > 0 ? slash.map((c) => `/${c.name}`) : shownFiles;
  const activeIndex = Math.min(menuIndex, Math.max(0, menu.length - 1));
  useEffect(() => {
    if (menu.length > 0)
      document
        .getElementById(`${menuId}-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, menu.length, menuId]);
  const choose = (index: number) => {
    if (slash.length > 0) {
      const selected = slash[index];
      if (selected)
        void agent.runCommand(`/${selected.name}`).then((accepted) => {
          if (accepted && !commandMenu) {
            setText((current) => (current === text ? "" : current));
            setCaret(0);
          }
        });
      setCommandMenu(false);
      setDismissed(true);
      area.current?.focus();
      return;
    }
    const path = shownFiles[index];
    if (!path) return;
    const next = completeMention(text, caret, path);
    setText(next.text);
    setCaret(next.caret);
    window.requestAnimationFrame(() =>
      area.current?.setSelectionRange(next.caret, next.caret),
    );
  };
  const canSend =
    !(disabledReason && !text.trimStart().startsWith("/")) && (text.trim() !== "" || attachments > 0);
  const submit = async () => {
    if (!canSend) return;
    const sent = await agent.send(text);
    if (sent) {
      setText((current) => (current === text ? "" : current));
      area.current?.focus();
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && menu.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      setCommandMenu(false);
      return;
    }
    if (
      menu.length > 0 &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      setMenuIndex(
        (i) =>
          (i + (event.key === "ArrowDown" ? 1 : menu.length - 1)) % menu.length,
      );
      return;
    }
    if (
      menu.length > 0 &&
      (event.key === "Tab" || event.key === "Enter") &&
      !event.shiftKey
    ) {
      event.preventDefault();
      choose(activeIndex);
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
        <div
          id={menuId}
          className="agent-prompt__menu"
          role="listbox"
          aria-label={t("agent.prompt.suggestions")}
        >
          <div className="agent-prompt__menu-heading">
            {t("agent.composer.commands")}
          </div>
          {menu.map((item, index) => (
            <button
              id={`${menuId}-${index}`}
              key={item}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={
                index === activeIndex
                  ? "agent-prompt__item agent-prompt__item--active"
                  : "agent-prompt__item"
              }
              onClick={() => {
                choose(index);
              }}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
            >
              <span className="agent-prompt__item-name">{item}</span>
              {slash[index] ? (
                <span className="agent-prompt__item-hint">
                  {slash[index].description}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className={
          busy
            ? "agent-prompt__box agent-prompt__box--busy"
            : "agent-prompt__box"
        }
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const dropped = Array.from(event.dataTransfer.files);
          if (dropped.length) void agent.attachFiles(dropped);
        }}
      >
        {activeFile || attachments > 0 ? (
          <div className="agent-composer__context">
            {activeFile ? <ActiveFileChip path={activeFile} included={includeFile} /> : null}
            <AttachmentChips />
          </div>
        ) : null}
        <textarea
          ref={area}
          className="agent-prompt__input"
          rows={2}
          value={text}
          spellCheck={false}
          placeholder={disabledReason ?? t("agent.prompt.placeholder")}
          aria-label={t("agent.prompt.label")}
          aria-autocomplete="list"
          aria-controls={menu.length > 0 ? menuId : undefined}
          aria-activedescendant={
            menu.length > 0 ? `${menuId}-${activeIndex}` : undefined
          }
          aria-haspopup="listbox"
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setMenuIndex(0);
            setDismissed(false);
            setCommandMenu(false);
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart);
          }}
          onKeyDown={onKey}
        />
        <div className="agent-composer__toolbar">
          <ModeButton mode={mode} />
          <span className="agent-composer__spacer" />
          {contextShare !== null && contextShare > 0 ? (
            <span
              className={contextShare >= 80 ? "agent-composer__context-use agent-composer__context-use--high" : "agent-composer__context-use"}
              title={t("agent.context.title")}
            >
              {t("agent.context.used", { percent: contextShare })}
            </span>
          ) : null}
          <AttachButton />
          <button
            type="button"
            className="agent-composer__icon agent-composer__shortcut"
            aria-label={t("agent.composer.commands")}
            title={t("agent.composer.commands")}
            onClick={() => {
              setCommandMenu(true);
              setMenuIndex(0);
              setDismissed(false);
              area.current?.focus();
            }}
          >
            /
          </button>
          {!busy || text.trim() ? (
            <button
              type="button"
              className="agent-composer__send"
              aria-label={t(busy ? "agent.tasks.queue" : "agent.tasks.send")}
              title={t(busy ? "agent.tasks.queue" : "agent.tasks.send")}
              disabled={!canSend}
              onClick={() => void submit()}
            >
              ↑
            </button>
          ) : null}
          {busy ? (
            <button
              type="button"
              className="agent-composer__stop"
              aria-label={t("agent.tasks.stop")}
              title={t("agent.tasks.stop")}
              onClick={() => void agent.stop()}
            >
              <span aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
