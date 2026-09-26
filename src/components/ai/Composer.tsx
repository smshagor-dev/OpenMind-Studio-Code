import { container } from "../../services/container";
import { useChat, useProviders } from "./aiHooks";

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
            Dismiss
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
        title={sending ? "Wait for the answer, or press Stop." : "Start a new, empty chat"}
        onClick={() => {
          container.ai.chat.newChat();
        }}
      >
        New chat
      </button>
      <button
        type="button"
        className="ai-link"
        disabled={sending || empty}
        title="Clear this chat (and delete its saved copy)"
        onClick={() => {
          void container.ai.chat.clear();
        }}
      >
        Clear chat
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
        aria-label="Message"
        placeholder="Ask the AI…  (Enter to send, Shift+Enter for a new line)"
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
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="ai-button ai-button--primary"
            disabled={blocker !== null || empty}
            title={blocker ?? (empty ? "Type a message first." : "Send")}
            onClick={send}
          >
            Send
          </button>
        )}
        <ChatButtons sending={chat.sending} empty={chat.messages.length === 0} />
      </div>
    </div>
  );
}
