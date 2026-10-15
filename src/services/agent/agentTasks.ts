import { attachment } from "./historyValidation";
import type { AgentMode } from "./agentIpc";
import { agentOptions } from "./agentOptions";
import type { AgentOptions } from "./agentOptions";

export type TaskStatus = "pending" | "running" | "stopping" | "completed" | "cancelled" | "failed";
export interface AgentTask {
  attachments?: import("./agentAttachments").AgentAttachment[];
  id: string;
  text: string;
  mode: AgentMode;
  modelId: string;
  workspace: string | null;
  options: AgentOptions;
  status: TaskStatus;
  reason: string | null;
  createdAt: number;
}
export interface TaskState { tasks: AgentTask[]; activeId: string | null; paused: boolean }
export const EMPTY_TASKS: TaskState = { tasks: [], activeId: null, paused: false };

export function lastInterruptedTask(tasks: readonly AgentTask[]): AgentTask | undefined {
  return [...tasks].reverse().find((task) => task.status === "failed" || (task.status === "cancelled" && task.reason === "cancelled"));
}

interface TaskHost {
  run: (task: AgentTask, signal: AbortSignal) => Promise<boolean>;
  stop: (id: string) => Promise<void>;
  changed: (state: TaskState) => void;
}

/** Controller for one window: exactly one dispatched task; Stop never drains the queue. */
export class AgentTasks {
  private state: TaskState = EMPTY_TASKS;
  private dispatching = false;
  private abort: AbortController | null = null;
  constructor(private readonly host: TaskHost) {}
  getState(): TaskState { return this.state; }
  private set(change: Partial<TaskState>): void {
    this.state = { ...this.state, ...change };
    this.host.changed(this.state);
  }
  restore(value: unknown): void {
    if (!Array.isArray(value)) return;
    const tasks: AgentTask[] = [];
    for (const raw of value.slice(-100)) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as Record<string, unknown>;
      if (typeof t.id !== "string" || !t.id || t.id.length > 128 || tasks.some((item) => item.id === t.id) || typeof t.text !== "string" || t.text.length > 100000 || typeof t.modelId !== "string") continue;
      if (t.mode !== "ask" && t.mode !== "acceptEdits" && t.mode !== "auto" && t.mode !== "plan") continue;
      const terminal = t.status === "completed" || t.status === "cancelled" || t.status === "failed";
      tasks.push({ attachments: Array.isArray(t.attachments) ? t.attachments.slice(0, 6).filter(attachment) : [], id: t.id, text: t.text, modelId: t.modelId, mode: t.mode,
        workspace: typeof t.workspace === "string" ? t.workspace : null,
        options: agentOptions(t.options), status: terminal ? t.status as TaskStatus : "pending",
        reason: terminal ? (typeof t.reason === "string" ? t.reason : null) : "interrupted",
        createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
      });
    }
    const bounded = tasks.filter((t, index) => t.status !== "pending" || tasks.slice(0, index).filter((item) => item.status === "pending").length < 20);
    this.set({ tasks: bounded, activeId: null, paused: tasks.some((t) => t.status === "pending") });
  }
  enqueue(task: AgentTask, first = false): boolean {
    if (this.state.tasks.filter((t) => t.status === "pending").length >= 20) return false;
    const retained = this.state.tasks.filter((t) => t.status === "pending" || t.id === this.state.activeId);
    const history = this.state.tasks.filter((t) => !retained.includes(t)).slice(-79);
    this.set({ tasks: [...history, ...(first ? [task, ...retained] : [...retained, task])], paused: this.state.paused || !task.options.autoRunQueue });
    void this.pump();
    return true;
  }
  private async pump(): Promise<void> {
    if (this.dispatching || this.state.activeId || this.state.paused) return;
    const task = this.state.tasks.find((t) => t.status === "pending");
    if (!task) return;
    this.dispatching = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    // Publish pending first, then transition to running on the dispatch microtask.
    await Promise.resolve();
    if (this.getState().paused || !this.getState().tasks.some((t) => t.id === task.id && t.status === "pending")) {
      this.dispatching = false;
      if (!this.getState().paused) void this.pump();
      return;
    }
    this.set({ activeId: task.id, tasks: this.state.tasks.map((t) => t.id === task.id ? { ...t, status: "running" } : t) });
    try {
      if (!await this.host.run(task, signal) && this.state.activeId === task.id) this.finish(signal.aborted ? "cancelled" : "error");
    } catch {
      if (this.state.activeId === task.id) this.finish(signal.aborted ? "cancelled" : "error");
    } finally {
      this.dispatching = false;
      if (this.state.activeId === null) void this.pump();
    }
  }
  finish(reason: string): void {
    const id = this.state.activeId;
    if (!id) return;
    const status: TaskStatus = reason === "done" ? "completed" : reason === "cancelled" ? "cancelled" : "failed";
    this.set({ activeId: null, paused: this.state.paused || reason !== "done",
      tasks: this.state.tasks.map((t) => t.id === id ? { ...t, status, reason } : t) });
    this.abort = null;
    void this.pump();
  }
  async stop(): Promise<void> {
    this.set({ paused: true });
    this.abort?.abort();
    const id = this.state.activeId;
    if (!id) return;
    this.set({ tasks: this.state.tasks.map((t) => t.id === id ? { ...t, status: "stopping" } : t) });
    await this.host.stop(id);
  }
  cancel(id: string): void {
    this.set({ tasks: this.state.tasks.map((t) => t.id === id && t.status === "pending" ? { ...t, status: "cancelled" } : t) });
  }
  pause(): void { this.set({ paused: true }); }
  resume(): void { this.set({ paused: false }); void this.pump(); }
  clear(): void { this.abort?.abort(); this.set(EMPTY_TASKS); }
}
