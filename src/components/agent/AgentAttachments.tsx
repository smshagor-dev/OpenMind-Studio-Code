import { useRef, useState, useSyncExternalStore } from "react";
import { agent } from "../../services/agent";
import { useT } from "../../i18n";
export function AgentAttachments() {
  const t = useT();
  const state = useSyncExternalStore(
    (listener) => agent.subscribe(listener),
    () => agent.getState(),
  );
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
    <div
      className="agent-attachments"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!loading) void add(Array.from(event.dataTransfer.files));
      }}
    >
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
        className="agent-composer__attach"
        aria-label={t("agent.attach.add")}
        title={t("agent.attach.hint")}
        disabled={loading}
        onClick={() => {
          input.current?.click();
        }}
      >
        <span aria-hidden="true">{loading ? "…" : "+"}</span>
      </button>
      {(state.attachments ?? []).map((item) => (
        <span className="agent-attachment" key={item.id}>
          {item.data ? <img src={item.data} alt="" /> : null}
          {item.name}
          <button
            type="button"
            aria-label={t("agent.attach.remove")}
            onClick={() => {
              agent.removeAttachment(item.id);
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

