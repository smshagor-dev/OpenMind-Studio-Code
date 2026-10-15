import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/** `openmind_agent::policy::Mode`. */
export type AgentMode = "ask" | "acceptEdits" | "plan";

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

export interface AgentOverview {
  hardware: Hardware;
  models: ModelView[];
  recommended: string | null;
  engineInstalled: boolean;
  runningModel: string | null;
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
export type AgentEvent =
  | { type: "thinking"; step: number }
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "toolStart"; id: string; name: string; kind: ToolKind; title: string; target: string }
  | {
      type: "toolEnd";
      id: string;
      ok: boolean;
      summary: string;
      preview: string;
      diff: FileDiff | null;
      changed: { path: string; rel: string; kind: "created" | "modified" | "deleted" } | null;
    }
  | { type: "todos"; items: Todo[] }
  | { type: "usage"; promptTokens: number; completionTokens: number; contextTokens: number }
  | { type: "turnEnd"; reason: "done" | "cancelled" | "rejected" | "limit" | "error"; message: string | null }
  | { type: "permission"; request: PermissionRequest }
  | { type: "engine"; state: "loading" | "ready" | "failed"; model: string; message: string | null };

export type Decision = { decision: "allow" } | { decision: "allowSession" } | { decision: "deny"; feedback: string | null };

export interface SendRequest {
  text: string;
  modelId: string;
  mode: AgentMode;
  unsaved: string[];
  uiLanguage: string;
}

export interface AgentIpc {
  overview: () => Promise<AgentOverview>;
  download: (id: string) => Promise<void>;
  cancelDownload: (id: string) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  send: (request: SendRequest) => Promise<void>;
  answer: (id: string, decision: Decision) => Promise<boolean>;
  stop: () => Promise<void>;
  reset: () => Promise<void>;
  undo: () => Promise<{ restored: string[]; failed: string[]; canUndo: boolean }>;
  stopEngine: () => Promise<void>;
  onEvent: (listener: (event: AgentEvent) => void) => Promise<() => void>;
  onDownload: (listener: (event: DownloadEvent) => void) => Promise<() => void>;
}

export const tauriAgentIpc: AgentIpc = {
  overview: () => invoke<AgentOverview>("agent_overview"),
  download: (id) => invoke("agent_model_download", { id }),
  cancelDownload: (id) => invoke("agent_model_cancel", { id }),
  deleteModel: (id) => invoke("agent_model_delete", { id }),
  send: (request) => invoke("agent_send", { request }),
  answer: (id, decision) => invoke<boolean>("agent_answer", { answer: { id, ...decision } }),
  stop: () => invoke("agent_stop"),
  reset: () => invoke("agent_reset"),
  undo: () => invoke<{ restored: string[]; failed: string[]; canUndo: boolean }>("agent_undo"),
  stopEngine: () => invoke("agent_engine_stop"),
  onEvent: (listener) =>
    listen<AgentEvent>(
      "agent:event",
      (event) => {
        listener(event.payload);
      },
      { target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label } },
    ),
  onDownload: (listener) =>
    listen<DownloadEvent>("agent:download", (event) => {
      listener(event.payload);
    }),
};

