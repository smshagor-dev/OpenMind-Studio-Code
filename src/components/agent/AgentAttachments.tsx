import { useRef, useState, useSyncExternalStore } from "react";
import { agent } from "../../services/agent";
import { useT } from "../../i18n";

function useAgentState() {
  return useSyncExternalStore(
    (listener) => agent.subscribe(listener),
    () => agent.getState(),
  );
}

/** The composer's attach button (bottom row): picks files and adds them to the next message. */
export function AttachButton() {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const add = async (files: File[]) => {
    setLoading(true);
    try {
      await agent.attachFiles(files);
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <input
        hidden
        ref={input}
        type="file"
        multiple
        onChange={(event) => {
          if (event.target.files) void add(Array.from(event.target.files));
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="agent-composer__icon agent-composer__attach"
        aria-label={t("agent.attach.add")}
        title={t("agent.attach.hint")}
        disabled={loading}
        onClick={() => {
          input.current?.click();
        }}
      >
        <span aria-hidden="true">{loading ? "…" : "+"}</span>
      </button>
    </>
  );
}

/** The files added to the next message, as chips in the composer's context row. */
export function AttachmentChips() {
  const t = useT();
  const state = useAgentState();
  return (
    <>
      {(state.attachments ?? []).map((item) => (
        <span className="agent-chip agent-attachment" key={item.id} title={item.name}>
          {item.data ? <img src={item.data} alt="" /> : <span aria-hidden="true">▤</span>}
          <span className="agent-chip__name">{item.name}</span>
          <button
            type="button"
            className="agent-chip__remove"
            aria-label={t("agent.attach.remove")}
            onClick={() => {
              agent.removeAttachment(item.id);
            }}
          >
            ×
          </button>
        </span>
      ))}
    </>
  );
}
