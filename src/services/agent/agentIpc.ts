import type { AgentOptions } from "./agentOptions";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/** `openmind_agent::policy::Mode`. */
export type AgentMode = "ask" | "acceptEdits" | "auto" | "plan";

/** `openmind_agent::tools::ToolKind`. */
export type ToolKind = "read" | "edit" | "delete" | "command" | "meta";

/** `openmind_llm::fit::FitLevel`. */
export type FitLevel = "gpu" | "mixed" | "cpu" | "slow" | "tooBig";

export interface Gpu {
  name: string;
  vendor: string;
  vramBytes: number;
}

export interface Hardware {
  totalRamBytes: number;
  availableRamBytes: number;
  gpus: Gpu[];
  cpuThreads: number;
  avx2: boolean;
}

export interface ModelView {
  id: string;
  family: string;
  name: string;
  quant: string;
  publisher: string;
  description: string;
  totalParamsB: number;
  activeParamsB: number;
  contextTokens: number;
  repo: string;
  license: { name: string; url: string };
  sizeBytes: number;
  fit: { level: FitLevel; neededBytes: number; tokensPerSecond: number };
  local: { state: "notDownloaded" | "partial" | "ready"; bytesOnDisk: number };
  downloading: boolean;
}

/** llama.cpp layer placement for the currently running engine. */
export interface GpuReport {
  requested: boolean;
  mode: "cpu" | "cpuFallback" | "partial" | "gpu" | "unknown";
  offloadedLayers: number | null;
  totalLayers: number | null;
}

export interface AgentOverview {
  /** Legacy field retained for existing clients. */
  acceleration?: [boolean, number | null];
  gpuReport?: GpuReport | null;
  hardware: Hardware;
  models: ModelView[];
  recommended: string | null;
  engineInstalled: boolean;
  runningModel: string | null;
  runningContextTokens?: number | null;
  modelsDir: string;
  freeDiskBytes: number | null;
}

export interface DownloadProgress {
  phase: "downloading" | "verifying";
  file: number;
  files: number;
  doneBytes: number;
  totalBytes: number;
}

export interface DownloadEvent {
  id: string;
  state: "progress" | "done" | "failed" | "cancelled";
  progress: DownloadProgress | null;
  message: string | null;
}

export type DiffLineKind = "context" | "added" | "removed" | "gap";

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface FileDiff {
  added: number;
  removed: number;
  lines: DiffLine[];
  truncated: boolean;
}

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PermissionRequest {
  id: string;
  kind: ToolKind;
  title: string;
  target: string;
  diff: FileDiff | null;
}

/** What `agent:event` carries: `openmind_agent::AgentEvent`, the permission question and the engine's state. */
export type AgentEvent = (
  | { type: "asset"; name: string; data: string }
  | { type: "thinking"; step: number }
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | {
      type: "toolStart";
      id: string;
      name: string;
      kind: ToolKind;
      title: string;
      target: string;
    }
  | {
      type: "toolEnd";
      id: string;
      ok: boolean;
      summary: string;
      preview: string;
      diff: FileDiff | null;
      changed: {
        path: string;
        rel: string;
        kind: "created" | "modified" | "deleted";
      } | null;
    }
  | { type: "todos"; items: Todo[] }
  | {
      type: "usage";
      promptTokens: number;
      completionTokens: number;
      contextTokens: number;
    }
  | { type: "unchanged"; failed: number }
  | {
      type: "turnEnd";
      reason: "done" | "cancelled" | "rejected" | "limit" | "error";
      message: string | null;
    }
  | { type: "permission"; request: PermissionRequest }
  | {
      type: "engine";
      state: "loading" | "ready" | "failed";
      model: string;
      message: string | null;
    }
  | { type: "compacted"; beforeTokens: number; afterTokens: number }
  | { type: "continuing"; attempt: number }
) & { taskId?: string | null };

export type Decision =
  | { decision: "allow" }
  | { decision: "allowSession" }
  | { decision: "deny"; feedback: string | null };

export interface SendRequest {
  attachments?: import("./agentAttachments").AgentAttachment[];
  conversationId?: string;
  history?: { role: string; content: string }[];
  taskId?: string;
  workspace?: string | null;
  options?: AgentOptions;
  text: string;
  modelId: string;
  mode: AgentMode;
  unsaved: string[];
  uiLanguage: string;
  /** The file in front in the editor, relative to the open folder. */
  activeFile?: string | null;
}

export interface AgentIpc {
  control?: (action: string, argument?: string) => Promise<unknown>;
  overview: () => Promise<AgentOverview>;
  download: (id: string) => Promise<void>;
  cancelDownload: (id: string) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  send: (request: SendRequest) => Promise<void>;
  answer: (id: string, decision: Decision) => Promise<boolean>;
  stop: (taskId?: string) => Promise<void>;
  waitIdle?: () => Promise<void>;
  reset: () => Promise<void>;
  undo: () => Promise<{
    restored: string[];
    failed: string[];
    canUndo: boolean;
  }>;
  startEngine: (id: string, useGpu?: boolean, contextTokens?: number) => Promise<boolean>;
  stopEngine: () => Promise<void>;
  /** The agent's background commands still running (id and command). */
  backgroundList: () => Promise<{ id: string; command: string }[]>;
  backgroundKill: (id: string) => Promise<string>;
  onEvent: (listener: (event: AgentEvent) => void) => Promise<() => void>;
  onDownload: (listener: (event: DownloadEvent) => void) => Promise<() => void>;
}

export const tauriAgentIpc: AgentIpc = {
  control: (action, argument) =>
    invoke("agent_control", { action, argument: argument ?? "" }),
  overview: () => invoke<AgentOverview>("agent_overview"),
  download: (id) => invoke("agent_model_download", { id }),
  cancelDownload: (id) => invoke("agent_model_cancel", { id }),
  deleteModel: (id) => invoke("agent_model_delete", { id }),
  send: (request) => invoke("agent_send", { request }),
  answer: (id, decision) =>
    invoke<boolean>("agent_answer", { answer: { id, ...decision } }),
  stop: (taskId) => invoke("agent_stop", { taskId: taskId ?? null }),
  waitIdle: () => invoke("agent_wait_idle"),
  reset: () => invoke("agent_reset"),
  undo: () =>
    invoke<{ restored: string[]; failed: string[]; canUndo: boolean }>(
      "agent_undo",
    ),
  startEngine: (id, useGpu, contextTokens) =>
    invoke<boolean>("agent_engine_start", {
      id,
      useGpu: useGpu ?? true,
      contextTokens: contextTokens ?? 0,
    }),
  stopEngine: () => invoke("agent_engine_stop"),
  backgroundList: () => invoke<{ id: string; command: string }[]>("agent_background_list"),
  backgroundKill: (id) => invoke<string>("agent_background_kill", { id }),
  onEvent: async (listener) => {
    const off = await listen<AgentEvent>(
      "agent:event",
      (event) => {
        listener(event.payload);
      },
      {
        target: {
          kind: "WebviewWindow",
          label: getCurrentWebviewWindow().label,
        },
      },
    );
    try {
      const offEngine = await listen<AgentEvent>("agent:engine", (event) => {
        listener(event.payload);
      });
      return () => {
        off();
        offEngine();
      };
    } catch (error) {
      off();
      throw error;
    }
  },
  onDownload: (listener) =>
    listen<DownloadEvent>("agent:download", (event) => {
      listener(event.payload);
    }),
};
