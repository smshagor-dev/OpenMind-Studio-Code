import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { container } from "../services/container";
import type {
  ConfirmPrompt,
  InputPrompt,
  MessagePrompt,
  QuickPickPrompt,
} from "../services/extensionPromptService";
import "../styles/extensions.css";

function Message({ message }: { message: MessagePrompt }) {
  const prompts = container.extensions.prompts;
  return (
    <div className={`ext-toast ext-toast--${message.severity}`} role="alert">
      <p>
        <strong>{message.extension}</strong> {message.message}
      </p>
      <div className="ext-toast__actions">
        {message.items.map((item) => (
          <button
            key={item}
            type="button"
            className="ext-button"
            onClick={() => {
              prompts.answer(message.id, item);
            }}
          >
            {item}
          </button>
        ))}
        <button
          type="button"
          className="ext-link"
          aria-label="Dismiss"
          onClick={() => {
            prompts.dismiss(message.id);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function QuickPick({ prompt }: { prompt: QuickPickPrompt }) {
  const prompts = container.extensions.prompts;
  const [picked, setPicked] = useState<number[]>([]);
  return (
    <div
      className="modal-overlay"
      onClick={() => {
        prompts.dismiss(prompt.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") prompts.dismiss(prompt.id);
      }}
    >
      <div
        className="modal ext-quickpick"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.placeHolder ?? "Pick an item"}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2>{prompt.placeHolder ?? `${prompt.extension} asks you to pick`}</h2>
        <ul className="ext-plain-list">
          {prompt.items.map((item, index) => (
            <li key={`${item.label}-${String(index)}`}>
              <button
                type="button"
                className={picked.includes(index) ? "ext-pick ext-pick--on" : "ext-pick"}
                onClick={() => {
                  if (prompt.canPickMany) {
                    setPicked((current) =>
                      current.includes(index)
                        ? current.filter((value) => value !== index)
                        : [...current, index],
                    );
                  } else {
                    prompts.answer(prompt.id, index);
                  }
                }}
              >
                <span>{item.label}</span>
                {item.description ? <span className="ext-note"> {item.description}</span> : null}
                {item.detail ? <span className="ext-note"> {item.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="modal__actions">
          {prompt.canPickMany ? (
            <button
              type="button"
              className="modal__confirm--primary"
              onClick={() => {
                prompts.answer(prompt.id, [...picked].sort((a, b) => a - b));
              }}
            >
              OK
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              prompts.dismiss(prompt.id);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function InputBox({ prompt }: { prompt: InputPrompt }) {
  const prompts = container.extensions.prompts;
  const [value, setValue] = useState(prompt.value);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      className="modal-overlay"
      onClick={() => {
        prompts.dismiss(prompt.id);
      }}
    >
      <form
        className="modal ext-input"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.title ?? prompt.prompt ?? "Enter a value"}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          prompts.answer(prompt.id, value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") prompts.dismiss(prompt.id);
        }}
      >
        <h2>{prompt.title ?? prompt.prompt ?? `${prompt.extension} asks for a value`}</h2>
        {prompt.title !== null && prompt.prompt !== null ? <p>{prompt.prompt}</p> : null}
        <input
          ref={ref}
          type={prompt.password ? "password" : "text"}
          value={value}
          placeholder={prompt.placeHolder ?? undefined}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
        <div className="modal__actions">
          <button type="submit" className="modal__confirm--primary">
            OK
          </button>
          <button
            type="button"
            onClick={() => {
              prompts.dismiss(prompt.id);
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/** A confirmation before a consequential action: explicit buttons only, Cancel has the focus. */
function ConfirmBox({ prompt }: { prompt: ConfirmPrompt }) {
  const prompts = container.extensions.prompts;
  const cancel = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <div className="modal-overlay">
      <div
        className="modal ext-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={prompt.title}
        onKeyDown={(event) => {
          if (event.key === "Escape") prompts.dismiss(prompt.id);
        }}
      >
        <h2>{prompt.title}</h2>
        <p className="ext-confirm__from">Requested by {prompt.extension}</p>
        <dl className="ext-confirm__details">
          {prompt.details.map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd>
                <code>{line.value}</code>
              </dd>
            </div>
          ))}
        </dl>
        {prompt.notes.map((note) => (
          <p key={note} className="ext-confirm__note">
            {note}
          </p>
        ))}
        <div className="modal__actions">
          {prompt.buttons.map((label, index) => (
            <button
              key={label}
              type="button"
              className={index === 0 ? "modal__confirm--primary" : undefined}
              onClick={() => {
                prompts.answer(prompt.id, label);
              }}
            >
              {label}
            </button>
          ))}
          <button
            ref={cancel}
            type="button"
            onClick={() => {
              prompts.dismiss(prompt.id);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** What extensions ask the user: messages (with buttons), a quick pick, an input box, a confirmation. UI only. */
export function ExtensionPrompts() {
  const prompts = container.extensions.prompts;
  const state = useSyncExternalStore(
    (listener) => prompts.subscribe(listener),
    () => prompts.getState(),
  );
  return (
    <>
      {state.messages.length > 0 ? (
        <div className="ext-toasts" aria-label="Extension messages">
          {state.messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </div>
      ) : null}
      {state.dialog?.kind === "quickPick" ? <QuickPick prompt={state.dialog} /> : null}
      {state.dialog?.kind === "input" ? <InputBox prompt={state.dialog} /> : null}
      {state.dialog?.kind === "confirm" ? <ConfirmBox prompt={state.dialog} /> : null}
    </>
  );
}
