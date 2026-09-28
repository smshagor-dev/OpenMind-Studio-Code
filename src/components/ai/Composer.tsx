import { container } from "../../services/container";
import { useChat, useProviders } from "./aiHooks";
import { t } from "../../i18n";

function Notices({ notice }: { notice: string | null }) {
  const warning = container.ai.chat.contextWarning();
  return (
    <>
      {warning !== null ? (
        <p className="ai-note ai-note--warn" role="note">
          {warning}
        </p>
      ) : null}
      {notice !== null ? (
        <p className="ai-note ai-note--error" role="alert">
          {notice}{" "}
          <button
            type="button"
            className="ai-link"
            onClick={() => {
              container.ai.chat.dismissNotice();
            }}
          >
            {t("common.dismissAction")}
          </button>
        </p>
      ) : null}
    </>
  );
}

function ChatButtons({ sending, empty }: { sending: boolean; empty: boolean }) {
  return (
    <>
      <button
        type="button"
        className="ai-link"
        disabled={sending || empty}
        title={sending ? t("ai.waitOrStop") : t("ai.newChatTitle")}
        onClick={() => {
          container.ai.chat.newChat();
        }}
      >
        {t("ai.newChat")}
      </button>
      <button
        type="button"
        className="ai-link"
        disabled={sending || empty}
        title={t("ai.clearChatTitle")}
        onClick={() => {
          void container.ai.chat.clear();
        }}
      >
        {t("ai.clearChat")}
      </button>
    </>
  );
}

/** The message box with Send (or Stop while an answer arrives), New chat and Clear chat. */
export function Composer() {
  const chat = useChat();
  useProviders();
  const blocker = container.ai.chat.sendBlocker();
  const empty = chat.draft.trim() === "";
  const send = () => {
    void container.ai.chat.sendDraft();
  };
  return (
    <div className="ai-composer">
      <Notices notice={chat.notice} />
      <textarea
        className="ai-composer__input"
        aria-label={t("ai.message")}
        placeholder={t("ai.placeholder")}
        rows={3}
        value={chat.draft}
        onChange={(event) => {
          container.ai.chat.setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="ai-composer__row">
        {chat.sending ? (
          <button
            type="button"
            className="ai-button"
            onClick={() => {
              void container.ai.chat.stop();
            }}
          >
            {t("lsp.stop")}
          </button>
        ) : (
          <button
            type="button"
            className="ai-button ai-button--primary"
            disabled={blocker !== null || empty}
            title={blocker ?? (empty ? t("ai.typeFirst") : t("ai.send"))}
            onClick={send}
          >
            {t("ai.send")}
          </button>
        )}
        <ChatButtons sending={chat.sending} empty={chat.messages.length === 0} />
      </div>
    </div>
  );
}
