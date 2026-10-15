// The OpenMindAI Agent's conversation as data: each event from the backend is folded into the transcript the panel
// draws (messages, tool cards, the permission question, the spinner's phase). Pure, so every rule is unit-tested.
import type { AgentEvent, AgentMode, FileDiff, PermissionRequest, Todo, ToolKind } from "./agentIpc";

export type ToolStatus = "running" | "waiting" | "ok" | "failed" | "declined";

export type Entry =
  | { kind: "document"; id: string; name: string; text: string }
  | { kind: "asset"; id: string; name: string; data: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; reasoning: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      toolKind: ToolKind;
      title: string;
      target: string;
      status: ToolStatus;
      summary: string;
      preview: string;
      diff: FileDiff | null;
      changedPath: string | null;
    }
  | { kind: "notice"; id: string; tone: "info" | "error"; text: string };

/** What the spinner says the agent is doing. */
export type Phase = "idle" | "loadingModel" | "thinking" | "responding" | "tool" | "waiting";

export interface Transcript {
  entries: Entry[];
  busy: boolean;
  phase: Phase;
  permission: PermissionRequest | null;
  todos: Todo[];
  /** When the running turn started (for the spinner's elapsed time). */
  startedAt: number | null;
  /** Tokens the model wrote in this turn, and the conversation's size against the context. */
  outputTokens: number;
  promptTokens: number;
  contextTokens: number;
  canUndo: boolean;
}

export const EMPTY_TRANSCRIPT: Transcript = {
  entries: [],
  busy: false,
  phase: "idle",
  permission: null,
  todos: [],
  startedAt: null,
  outputTokens: 0,
  promptTokens: 0,
  contextTokens: 0,
  canUndo: false,
};

const nextId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

export function addUser(t: Transcript, text: string, now: number): Transcript {
  return {
    ...t,
    entries: [...t.entries, { kind: "user", id: nextId("u"), text }],
    busy: true,
    phase: "thinking",
    permission: null,
    startedAt: now,
    outputTokens: 0,
  };
}

export function addNotice(t: Transcript, tone: "info" | "error", text: string): Transcript {
  return { ...t, entries: [...t.entries, { kind: "notice", id: nextId("n"), tone, text }] };
}

/** Appends to the assistant message being written, or starts one (after a tool card, a new one begins). */
function appendAssistant(t: Transcript, field: "text" | "reasoning", piece: string): Transcript {
  const entries = t.entries.slice();
  const last = entries[entries.length - 1];
  if (last?.kind === "assistant") {
    entries[entries.length - 1] = { ...last, [field]: last[field] + piece };
  } else {
    entries.push({
      kind: "assistant",
      id: nextId("a"),
      text: field === "text" ? piece : "",
      reasoning: field === "reasoning" ? piece : "",
    });
  }
  return { ...t, entries, phase: field === "text" ? "responding" : "thinking" };
}

function updateTool(t: Transcript, id: string, change: Partial<Extract<Entry, { kind: "tool" }>>): Entry[] {
  return t.entries.map((e) => (e.kind === "tool" && e.id === id ? { ...e, ...change } : e));
}

/** A reason a turn ended, as the notice the panel shows (none for a normal end). */
export type EndNotice = { tone: "info" | "error"; key: string; message: string | null } | null;

export function endNotice(reason: string, message: string | null): EndNotice {
  switch (reason) {
    case "cancelled":
      return { tone: "info", key: "agent.end.interrupted", message: null };
    case "rejected":
      return { tone: "info", key: "agent.end.rejected", message: null };
    case "limit":
      return { tone: "info", key: "agent.end.limit", message };
    case "error":
      return { tone: "error", key: "agent.end.error", message };
    default:
      return message ? { tone: "info", key: "agent.end.note", message } : null;
  }
}

/** Folds one backend event into the transcript. `say` turns an end notice into text (it is translated). */
export function applyEvent(t: Transcript, event: AgentEvent, say: (notice: NonNullable<EndNotice>) => string): Transcript {
  switch (event.type) {
    case "asset":
      return { ...t, entries: [...t.entries, { kind: "asset", id: crypto.randomUUID(), name: event.name, data: event.data }] };
    case "thinking":
      return { ...t, phase: "thinking" };
    case "reasoning":
      return appendAssistant(t, "reasoning", event.text);
    case "text":
      return appendAssistant(t, "text", event.text);
    case "toolStart":
      return {
        ...t,
        phase: "tool",
        entries: [
          ...t.entries,
          {
            kind: "tool",
            id: event.id,
            name: event.name,
            toolKind: event.kind,
            title: event.title,
            target: event.target,
            status: "running",
            summary: "",
            preview: "",
            diff: null,
            changedPath: null,
          },
        ],
      };
    case "permission":
      return {
        ...t,
        phase: "waiting",
        permission: event.request,
        entries: updateTool(t, event.request.id, { status: "waiting", diff: event.request.diff }),
      };
    case "toolEnd": {
      const declined = !event.ok && event.summary === "Declined";
      return {
        ...t,
        phase: "thinking",
        permission: t.permission?.id === event.id ? null : t.permission,
        canUndo: t.canUndo || (event.ok && event.changed !== null),
        entries: updateTool(t, event.id, {
          status: declined ? "declined" : event.ok ? "ok" : "failed",
          summary: event.summary,
          preview: event.preview,
          diff: event.diff ?? null,
          changedPath: event.changed?.path ?? null,
        }),
      };
    }
    case "todos":
      return { ...t, todos: event.items };
    case "usage":
      return {
        ...t,
        outputTokens: t.outputTokens + event.completionTokens,
        promptTokens: event.promptTokens,
        contextTokens: event.contextTokens,
      };
    case "compacted":
      return addNotice(t, "info", say({ tone: "info", key: "agent.context.compacted", message: null }));
    case "continuing":
      return addNotice(t, "info", say({ tone: "info", key: "agent.context.continuing", message: null }));
    case "engine":
      if (event.state === "loading") return { ...t, phase: "loadingModel" };
      if (event.state === "ready") return { ...t, phase: "thinking" };
      return t;
    case "turnEnd": {
      const ended: Transcript = {
        ...t,
        busy: false,
        phase: "idle",
        permission: null,
        startedAt: null,
        // A tool still "running" when the turn ended was never finished.
        entries: t.entries.map((e) =>
          e.kind === "tool" && (e.status === "running" || e.status === "waiting") ? { ...e, status: "declined" } : e,
        ),
      };
      const notice = endNotice(event.reason, event.message);
      return notice ? addNotice(ended, notice.tone, say(notice)) : ended;
    }
  }
}

const MODES: AgentMode[] = ["ask", "acceptEdits", "auto", "plan"];

/** Shift+Tab moves through the modes, as in Claude Code. */
export function nextMode(mode: AgentMode): AgentMode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length] ?? "ask";
}

/** A byte count for people: `2.6 GB`, `512 MB`. */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** `12.3k` for a token count. */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** `1m 05s` / `42s` for the spinner. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The text after the last `@` being typed, when the caret is in a file mention. */
export function mentionQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  return match ? (match[1] ?? "") : null;
}

/** Replaces the mention being typed with `@path `. */
export function completeMention(text: string, caret: number, path: string): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  const insert = `@${path} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}
