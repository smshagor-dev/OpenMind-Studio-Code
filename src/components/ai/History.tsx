import { useState } from "react";

import { container } from "../../services/container";
import { useChat } from "./aiHooks";
import { t } from "../../i18n";

/** Saved conversations: open one, delete one, or clear them all. (Empty when saving is off.) */
export function History() {
  const chat = useChat();
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-history">
      <button
        type="button"
        className="ai-link"
        aria-expanded={open}
        onClick={() => {
          if (!open) void container.ai.chat.loadHistory();
          setOpen(!open);
        }}
      >
        {open ? t("ai.hideHistory") : t("ai.showHistory")}
      </button>
      {open && chat.history.length === 0 ? (
        <p className="ai-note">{t("ai.noHistory")}</p>
      ) : null}
      {open && chat.history.length > 0 ? (
        <>
          <ul className="ai-history__list">
            {chat.history.map((entry) => (
              <li key={entry.id} className="ai-history__item">
                <button
                  type="button"
                  className="ai-history__open"
                  title={entry.title}
                  onClick={() => {
                    void container.ai.chat.open(entry.id);
                  }}
                >
                  {entry.title}
                </button>
                <button
                  type="button"
                  className="ai-link"
                  aria-label={t("ai.deleteNamed", { name: entry.title })}
                  onClick={() => {
                    void container.ai.chat.deleteConversation(entry.id);
                  }}
                >
                  {t("runtimes.delete")}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="ai-link"
            onClick={() => {
              void container.ai.chat.clearHistory();
            }}
          >
            {t("ai.clearAllHistory")}
          </button>
        </>
      ) : null}
    </div>
  );
}
