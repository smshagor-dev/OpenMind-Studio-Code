import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Mirrors openmind_ai and src-tauri/src/commands/ai.rs (serde camelCase). An API key travels one way only: from the
// UI to the backend in `aiProviderSetKey`. Nothing ever returns it; the backend only says whether one is stored.

export type AiProviderKind = "claude" | "openai-compatible" | "gemini" | "local";

export type AiCapability =
  | "chat"
  | "streaming"
  | "embeddings"
  | "vision"
  | "toolCalling"
  | "localOffline"
  | "codeAssistance";

/** A configured provider (no secret in it). */
export interface AiProviderConfig {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  models: string[];
  enabled: boolean;
  /** The extension (`publisher.name`) that contributed the provider, if any. */
  source: string | null;
  capabilities: AiCapability[];
}

export interface AiProviderInfo extends AiProviderConfig {
  hasKey: boolean;
  needsKey: boolean;
  /** Requests stay on this computer (a loopback address). */
  local: boolean;
  /** The host content would be sent to. */
  host: string;
}

export interface AiModelInfo {
  id: string;
  chat: boolean;
  embedding: boolean;
}

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiChatRequest {
  model: string;
  system: string | null;
  messages: AiChatMessage[];
  maxTokens?: number;
}

export interface AiChatResult {
  text: string;
  cancelled: boolean;
}

export interface AiStoredMessage {
  role: "user" | "assistant";
  content: string;
  error: string | null;
  createdAt: number;
}

export interface AiConversation {
  id: string;
  title: string;
  providerId: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: AiStoredMessage[];
}

export interface AiConversationSummary {
  id: string;
  title: string;
  providerId: string;
  model: string;
  updatedAt: number;
  messageCount: number;
}

export interface AiChunk {
  requestId: string;
  text: string;
}

export interface AiIpc {
  aiProvidersList: () => Promise<AiProviderInfo[]>;
  aiProviderSave: (config: AiProviderConfig) => Promise<AiProviderInfo>;
  aiProviderDelete: (id: string) => Promise<void>;
  aiProviderSetEnabled: (id: string, enabled: boolean) => Promise<AiProviderInfo>;
  aiProviderSetKey: (id: string, key: string) => Promise<void>;
  aiProviderClearKey: (id: string) => Promise<void>;
  /** Asks the provider for its models: a request the user just asked for. */
  aiProviderTest: (id: string, requestId: string) => Promise<AiModelInfo[]>;
  aiChatSend: (
    requestId: string,
    providerId: string,
    request: AiChatRequest,
  ) => Promise<AiChatResult>;
  aiRequestCancel: (requestId: string) => Promise<void>;
  aiConversationsList: () => Promise<AiConversationSummary[]>;
  aiConversationLoad: (id: string) => Promise<AiConversation | null>;
  aiConversationSave: (conversation: AiConversation) => Promise<void>;
  aiConversationDelete: (id: string) => Promise<void>;
  aiConversationsClear: () => Promise<void>;
  /** Pieces of an answer as they arrive (for the window that asked). */
  onAiChunk: (listener: (chunk: AiChunk) => void) => Promise<() => void>;
}

export const tauriAiIpc: AiIpc = {
  aiProvidersList: () => invoke<AiProviderInfo[]>("ai_providers_list"),
  aiProviderSave: (config) => invoke<AiProviderInfo>("ai_provider_save", { config }),
  aiProviderDelete: (id) => invoke("ai_provider_delete", { id }),
  aiProviderSetEnabled: (id, enabled) =>
    invoke<AiProviderInfo>("ai_provider_set_enabled", { id, enabled }),
  aiProviderSetKey: (id, key) => invoke("ai_provider_set_key", { id, key }),
  aiProviderClearKey: (id) => invoke("ai_provider_clear_key", { id }),
  aiProviderTest: (id, requestId) => invoke<AiModelInfo[]>("ai_provider_test", { id, requestId }),
  aiChatSend: (requestId, providerId, request) =>
    invoke<AiChatResult>("ai_chat_send", { requestId, providerId, request }),
  aiRequestCancel: (requestId) => invoke("ai_request_cancel", { requestId }),
  aiConversationsList: () => invoke<AiConversationSummary[]>("ai_conversations_list"),
  aiConversationLoad: (id) => invoke<AiConversation | null>("ai_conversation_load", { id }),
  aiConversationSave: (conversation) => invoke("ai_conversation_save", { conversation }),
  aiConversationDelete: (id) => invoke("ai_conversation_delete", { id }),
  aiConversationsClear: () => invoke("ai_conversations_clear"),
  onAiChunk: (listener) =>
    listen<AiChunk>("ai:chunk", (event) => {
      listener(event.payload);
    }),
};
