import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Mirrors src-tauri/src/commands/collab/docs_commands.rs and net_docs.rs (Milestone 24, phase 6). Binary values
// (Yjs updates and state vectors) are base64. Nothing here is canonical state: document changes are transient events.

export type DocClosedReason = "deleted" | "unavailable" | "notEditable";

export type DocNotice =
  /** Owner: a participant opened `fileId`, which is `path` on this computer (the Owner's editor follows it). */
  | { kind: "active"; fileId: string; path: string }
  | { kind: "update"; fileId: string; update: string }
  | { kind: "closed"; fileId: string; reason: DocClosedReason }
  /** Participant: the answer to opening a document. */
  | { kind: "sync"; fileId: string; stateVector: string; update: string }
  /** Participant: may this member change files now (follows role changes at once). */
  | { kind: "access"; write: boolean }
  /** Participant: the Owner refused one of this member's changes. */
  | { kind: "rejected"; fileId: string; reason: string };

export interface DocEventPayload {
  roomUid: string;
  side: "host" | "participant";
  event: DocNotice;
}

export interface CollabDocIpc {
  ownerState: (roomUid: string, fileId: string) => Promise<string>;
  ownerUpdate: (roomUid: string, fileId: string, update: string) => Promise<void>;
  ownerBind: (roomUid: string, fileId: string, bound: boolean) => Promise<void>;
  subscribe: (roomUid: string, fileId: string, stateVector: string) => Promise<void>;
  send: (roomUid: string, fileId: string, update: string) => Promise<void>;
  unsubscribe: (roomUid: string, fileId: string) => Promise<void>;
  onDoc: (listener: (payload: DocEventPayload) => void) => Promise<UnlistenFn>;
}

export const DOC_EVENT = "collab:doc";

export const tauriCollabDocIpc: CollabDocIpc = {
  ownerState: (roomUid, fileId) => invoke("collab_doc_owner_state", { roomUid, fileId }),
  ownerUpdate: (roomUid, fileId, update) =>
    invoke("collab_doc_owner_update", { roomUid, fileId, update }),
  ownerBind: (roomUid, fileId, bound) =>
    invoke("collab_doc_owner_bind", { roomUid, fileId, bound }),
  subscribe: (roomUid, fileId, stateVector) =>
    invoke("collab_doc_subscribe", { roomUid, fileId, stateVector }),
  send: (roomUid, fileId, update) => invoke("collab_doc_send", { roomUid, fileId, update }),
  unsubscribe: (roomUid, fileId) => invoke("collab_doc_unsubscribe", { roomUid, fileId }),
  onDoc: (listener) =>
    listen<DocEventPayload>(DOC_EVENT, (event) => {
      listener(event.payload);
    }),
};

export function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
