import { invoke } from "@tauri-apps/api/core";
import type { Entry } from "./agentModel";
import type { AgentTask } from "./agentTasks";
import { attachment, entry } from "./historyValidation";
export interface HistorySummary {
  id: string;
  title: string;
  providerId: string;
  updatedAt: number;
  messageCount: number;
}
interface Stored {
  id: string;
  title: string;
  providerId: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: { role: string; content: string; createdAt: number; error: null }[];
}
export interface HistorySnapshot {
  id: string;
  title: string;
  workspace: string | null;
  entries: Entry[];
  tasks: AgentTask[];
  createdAt: number;
}
export interface HistoryIpc {
  list: () => Promise<HistorySummary[]>;
  load: (id: string) => Promise<Stored | null>;
  save: (value: Stored) => Promise<void>;
  delete: (id: string) => Promise<boolean>;
}
export const historyIpc: HistoryIpc = {
  list: () => invoke("agent_history_list"),
  load: (id) => invoke("agent_history_load", { id }),
  save: (conversation) => invoke("agent_history_save", { conversation }),
  delete: (id) => invoke("agent_history_delete", { id }),
};
/** Serialized writes prevent a slow older snapshot overwriting the latest streamed reply. */
export class AgentHistory {
  private writes: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: HistorySnapshot | null = null;
  constructor(
    private readonly ipc: HistoryIpc,
    private readonly failed: (error: unknown) => void,
  ) {}
  list(): Promise<HistorySummary[]> {
    return this.ipc.list();
  }
  async load(id: string): Promise<HistorySnapshot | null> {
    await this.flush();
    const value = await this.ipc.load(id);
    if (!value || value.model !== "agent-v1") return null;
    const entries: Entry[] = [];
    const tasks: AgentTask[] = [];
    const attached: { taskId: string; value: import("./agentAttachments").AgentAttachment }[] = [];
    for (const message of value.messages) {
      const parsed: unknown = JSON.parse(message.content);
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid history entry");
      if (message.role === "entry") {
        if (!entry(parsed)) throw new Error("Invalid history entry");
        entries.push(parsed);
      }
      if (message.role === "task") tasks.push(parsed as AgentTask);
      if (message.role === "attachment") {
        const item = parsed as Record<string, unknown>;
        if (typeof item.taskId !== "string" || !attachment(item.value))
          throw new Error("Invalid saved attachment");
        attached.push({ taskId: item.taskId, value: item.value });
      }
    }
    for (const item of attached) {
      const task = tasks.find((t) => t.id === item.taskId);
      if (task) task.attachments = [...(task.attachments ?? []), item.value].slice(0, 6);
    }
    return {
      id: value.id,
      title: value.title,
      workspace: value.providerId || null,
      entries,
      tasks,
      createdAt: value.createdAt,
    };
  }
  schedule(snapshot: HistorySnapshot): void {
    this.pending = snapshot;
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, 350);
  }
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = this.pending;
    this.pending = null;
    if (snapshot) {
      const value: Stored = {
        id: snapshot.id,
        title: snapshot.title,
        providerId: snapshot.workspace ?? "",
        model: "agent-v1",
        createdAt: snapshot.createdAt,
        updatedAt: Date.now(),
        messages: [
          ...snapshot.entries.map((entry) => ({
            role: "entry",
            content: JSON.stringify(entry),
            createdAt: Date.now(),
            error: null,
          })),
          ...snapshot.tasks.map((task) => ({
            role: "task",
            content: JSON.stringify({ ...task, attachments: [] }),
            createdAt: task.createdAt,
            error: null,
          })),
          ...snapshot.tasks.flatMap((task) =>
            (task.attachments ?? []).map((value) => ({
              role: "attachment",
              content: JSON.stringify({ taskId: task.id, value }),
              createdAt: task.createdAt,
              error: null,
            })),
          ),
        ],
      };
      this.writes = this.writes.then(() => this.ipc.save(value)).catch(this.failed);
    }
    return this.writes;
  }
  async delete(id: string): Promise<void> {
    await this.flush();
    await this.ipc.delete(id);
  }
}
