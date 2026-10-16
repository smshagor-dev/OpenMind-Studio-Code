import { useEffect, useRef, useState } from "react";
import { agent } from "../../services/agent";
import type { AgentState } from "../../services/agent/agentService";

/** Reports stay out of model context. Memory changes are explicit and use the native dirty-file guard. */
export function AgentCommandPanel({
  panel,
}: {
  panel: NonNullable<AgentState["commandPanel"]>;
}) {
  const dialog = useRef<HTMLElement>(null);
  const [memory, setMemory] = useState(panel.body);
  const [command, setCommand] = useState("");
  const [working, setWorking] = useState(false);
  const [source, setSource] = useState(panel.body);
  if (source !== panel.body) {
    setSource(panel.body);
    setMemory(panel.body);
  }
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  async function run(input: string) {
    setWorking(true);
    try {
      if (await agent.runCommand(input)) setCommand("");
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="agent-command-backdrop">
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={panel.title}
        className="agent-command-panel"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            agent.closeCommandPanel();
          }
          if (event.key === "Tab") {
            const elements = [
              ...(dialog.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled),textarea:not(:disabled)",
              ) ?? []),
            ];
            const first = elements[0],
              last = elements.at(-1);
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last ||
                document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h3>{panel.title}</h3>
          <button
            type="button"
            aria-label="Close command panel"
            onClick={() => {
              agent.closeCommandPanel();
            }}
          >
            ×
          </button>
        </header>
        {panel.error ? <p role="alert">{panel.error}</p> : null}
        {panel.kind === "memory" ? (
          <>
            <p>
              OPENMIND_MEMORY.md · shared project context for future turns.
              Maximum 32 KB.
            </p>
            <textarea
              aria-label="Project memory"
              value={memory}
              onChange={(e) => {
                setMemory(e.target.value);
              }}
            />
            <button
              type="button"
              disabled={working}
              onClick={() =>
                void run(
                  memory.trim() ? `/memory set ${memory}` : "/memory clear",
                )
              }
            >
              Save memory
            </button>
          </>
        ) : (
          <pre role={panel.kind === "error" ? "alert" : undefined}>
            {panel.body}
          </pre>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (command.trim()) void run(command);
          }}
        >
          <label>
            Command
            <input
              autoComplete="off"
              placeholder="/help or /mcp add local http://localhost:3000/mcp"
              value={command}
              onChange={(e) => {
                setCommand(e.target.value);
              }}
            />
          </label>
          <button
            type="submit"
            disabled={working || !command.trim().startsWith("/")}
          >
            {working ? "Running…" : "Run"}
          </button>
        </form>
      </section>
    </div>
  );
}
