import { useEffect, useRef } from "react";

import { container } from "../../services/container";
import type { ChatMessageView } from "../../services/ai/aiChatService";
import { splitSegments } from "../../services/ai/aiMessageText";
import { t } from "../../i18n";

function copy(text: string): void {
  void container.ipc.clipboardWriteText(text).then(
    () => {
      container.events.emit("appNotice", { message: t("ai.copied") });
    },
    (error: unknown) => {
      container.events.emit("appError", { message: t("ai.copyFailed", { error: String(error) }) });
    },
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const reason = container.ai.actions.insertReason();
  return (
    <div className="ai-code">
      <div className="ai-code__bar">
        <span className="ai-code__lang">{language === "" ? "code" : language}</span>
        <button
          type="button"
          className="ai-link"
          onClick={() => {
            copy(code);
          }}
        >
          {t("common.copy")}
        </button>
        <button
          type="button"
          className="ai-link"
          disabled={reason !== null}
          title={reason ?? t("ai.insertTitle")}
          onClick={() => {
            container.ai.actions.insert(code);
          }}
        >
          {t("ai.insert")}
        </button>
      </div>
      <pre className="ai-code__body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function MessageBody({ message }: { message: ChatMessageView }) {
  const segments = splitSegments(message.content);
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "code" ? (
          <CodeBlock key={index} language={segment.language} code={segment.code} />
        ) : (
          <p key={index} className="ai-message__text">
            {segment.text}
          </p>
        ),
      )}
      {message.streaming && message.content === "" ? (
        <p className="ai-message__text ai-message__waiting">{t("ai.waiting")}</p>
      ) : null}
    </>
  );
}

function Message({ message, isLast }: { message: ChatMessageView; isLast: boolean }) {
  const assistant = message.role === "assistant";
  return (
    <li className={assistant ? "ai-message ai-message--assistant" : "ai-message ai-message--user"}>
      <div className="ai-message__head">
        <span className="ai-message__role">{assistant ? t("view.ai") : t("ai.you")}</span>
        {message.content !== "" ? (
          <button
            type="button"
            className="ai-link"
            onClick={() => {
              copy(message.content);
            }}
          >
            {t("common.copy")}
          </button>
        ) : null}
      </div>
      <MessageBody message={message} />
      {message.stopped ? <p className="ai-message__note">{t("ai.stopped")}</p> : null}
      {message.error !== null ? (
        <div className="ai-message__error" role="alert">
          <span>{message.error}</span>
          {isLast ? (
            <button
              type="button"
              className="ai-link"
              onClick={() => {
                void container.ai.chat.retry();
              }}
            >
              {t("common.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The conversation: prose as text nodes and code as blocks with Copy / Insert. No HTML is ever injected. */
export function ChatMessages({ messages }: { messages: ChatMessageView[] }) {
  const endRef = useRef<HTMLLIElement | null>(null);
  const last = messages[messages.length - 1];
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, last?.content]);
  if (messages.length === 0) {
    return <p className="ai-empty">{t("ai.empty")}</p>;
  }
  return (
    <ol className="ai-messages" aria-label={t("ai.conversation")}>
      {messages.map((message, index) => (
        <Message key={message.id} message={message} isLast={index === messages.length - 1} />
      ))}
      <li ref={endRef} aria-hidden="true" />
    </ol>
  );
}
