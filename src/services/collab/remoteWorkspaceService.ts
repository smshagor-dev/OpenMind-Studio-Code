import { t } from "../../i18n";
import type { CollabOrigin } from "../filePreviewService";
import type {
  CollabNetIpc,
  ManifestEntry,
  NetEventPayload,
  RemoteEventPayload,
  RemoteFile,
} from "./collabNetIpc";
import {
  EMPTY_TREE,
  applyDelta,
  collabUri,
  treeFromView,
  visibleRows,
  type RemoteRow,
  type RemoteTree,
} from "./remoteTree";

/** What the service needs from the workbench (wired in `collabWiring.ts`). */
export interface RemoteWorkspaceHost {
  /** Opens (or refreshes) a read-only `omcollab:` document tab. */
  openDocument: (request: {
    uri: string;
    text: string;
    language: string;
    extension: string;
    readonly: boolean;
    collab: CollabOrigin;
  }) => void;
  markDocument: (uri: string, state: CollabOrigin["state"]) => void;
  /** A live collaborative document follows the shared CRDT: no snapshot staleness for it (phase 6). */
  isLive?: (uri: string) => boolean;
  /** An opened file was renamed or moved: same document, new name. */
  renamed?: (uri: string, path: string) => void;
  languageOf: (path: string) => string;
  notice: (message: string) => void;
  error: (message: string) => void;
}

export interface RemoteRoomState {
  tree: RemoteTree;
  expanded: ReadonlySet<string>;
  selected: string | null;
  /** Files being fetched: bytes received / total (transient). */
  loading: ReadonlyMap<string, { received: number; total: number }>;
  connected: boolean;
}

const EMPTY_ROOM: RemoteRoomState = {
  tree: EMPTY_TREE,
  expanded: new Set(),
  selected: null,
  loading: new Map(),
  connected: true,
};

/** What an opened document was fetched as, to tell when the Owner's file moved on. */
interface Opened {
  roomUid: string;
  fileId: string;
  size: number;
  modifiedMs: number;
  sha256: string;
}

const FINISHED = new Set(["disconnected", "failed", "closed"]);

/**
 * A joined room's shared workspace on the participant side: the Owner's tree (fetched when the backend says it is ready,
 * kept current by deltas, fetched again when a delta doesn't follow), Explorer-style expand/select, and opening a file
 * as a read-only `omcollab://<room>/<file id>` snapshot document. Nothing is downloaded until a file is opened. An
 * opened document is marked *stale* when a delta reports a new size or time for its file (refresh fetches it again; no
 * content is pushed — Phase 6 brings live CRDT documents) and *unavailable* when the file leaves the tree or the room
 * disconnects. No Git, terminal, Run Code or language server ever acts on these documents: they are not files here.
 */
export class RemoteWorkspaceService {
  private rooms = new Map<string, RemoteRoomState>();
  private opened = new Map<string, Opened>();
  private listeners = new Set<() => void>();
  private treeRequests = new Map<string, number>();

  constructor(
    private readonly ipc: CollabNetIpc,
    private readonly host: RemoteWorkspaceHost,
  ) {}

  /** Starts following `collab:remote` and `collab:net`; returns the stop function. */
  async start(): Promise<() => void> {
    const remote = await this.ipc.onRemote((payload) => {
      void this.remoteEvent(payload);
    });
    const net = await this.ipc.onNet((payload) => {
      this.netEvent(payload);
    });
    return () => {
      remote();
      net();
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  room(roomUid: string): RemoteRoomState {
    return this.rooms.get(roomUid) ?? EMPTY_ROOM;
  }

  rows(roomUid: string): RemoteRow[] {
    const room = this.room(roomUid);
    return visibleRows(room.tree, room.expanded);
  }

  /** Reads the room's tree from the backend (after joining, or when it reported a new manifest). */
  async loadTree(roomUid: string): Promise<void> {
    const request = (this.treeRequests.get(roomUid) ?? 0) + 1;
    this.treeRequests.set(roomUid, request);
    try {
      const view = await this.ipc.remoteTree(roomUid);
      if (this.treeRequests.get(roomUid) !== request) return; // a newer read answers
      this.update(roomUid, { tree: treeFromView(view), connected: true });
      this.reconcileOpened(roomUid);
    } catch {
      this.update(roomUid, { tree: { ...this.room(roomUid).tree, ready: false } });
    }
  }

  toggle(roomUid: string, id: string): void {
    const room = this.room(roomUid);
    if (room.tree.entries.get(id)?.kind !== "folder") return;
    const expanded = new Set(room.expanded);
    if (!expanded.delete(id)) expanded.add(id);
    this.update(roomUid, { expanded, selected: id });
  }

  select(roomUid: string, id: string | null): void {
    this.update(roomUid, { selected: id });
  }

  /** Fetches a shared file and opens it as a read-only remote document. `false` when it couldn't be opened. */
  async open(roomUid: string, fileId: string): Promise<boolean> {
    const room = this.room(roomUid);
    const entry = room.tree.entries.get(fileId);
    if (!entry || entry.kind !== "file" || room.loading.has(fileId)) return false;
    this.setLoading(roomUid, fileId, { received: 0, total: entry.size });
    let file: RemoteFile;
    try {
      file = await this.ipc.remoteOpen(roomUid, fileId);
    } catch (err) {
      this.host.error(t("collab.remote.openFailed", { name: entry.name, reason: String(err) }));
      return false;
    } finally {
      this.setLoading(roomUid, fileId, null);
    }
    if (file.binary || file.text === null) {
      this.host.notice(t("collab.remote.binary", { name: file.name }));
      return false;
    }
    const uri = collabUri(roomUid, fileId);
    // The tree may have moved on while the file was in flight; record what the tree says now.
    const current = this.room(roomUid).tree.entries.get(fileId) ?? entry;
    this.opened.set(uri, {
      roomUid,
      fileId,
      size: current.size,
      modifiedMs: current.modifiedMs,
      sha256: file.sha256,
    });
    this.host.openDocument({
      uri,
      text: file.text,
      language: this.host.languageOf(file.path),
      extension: this.room(roomUid).tree.root,
      readonly: true,
      collab: {
        roomUid,
        fileId,
        room: this.room(roomUid).tree.root,
        path: file.path,
        sha256: file.sha256,
        state: "current",
      },
    });
    this.select(roomUid, fileId);
    return true;
  }

  /** Fetches an opened remote document again (after the Owner changed it). */
  async refresh(uri: string): Promise<boolean> {
    const opened = this.opened.get(uri);
    if (!opened) return false;
    return this.open(opened.roomUid, opened.fileId);
  }

  /** A remote document's tab closed: stop a transfer still running and forget it. */
  documentClosed(uri: string): void {
    const opened = this.opened.get(uri);
    if (!opened) return;
    this.opened.delete(uri);
    if (this.room(opened.roomUid).loading.has(opened.fileId)) {
      void this.ipc.remoteCancel(opened.roomUid, opened.fileId).catch(() => undefined);
    }
  }

  /** Cancels a file still being fetched (its row's cancel button, or the tab that wanted it went away). */
  cancel(roomUid: string, fileId: string): void {
    if (!this.room(roomUid).loading.has(fileId)) return;
    void this.ipc.remoteCancel(roomUid, fileId).catch(() => undefined);
  }

  private async remoteEvent(payload: RemoteEventPayload): Promise<void> {
    const { roomUid, event } = payload;
    switch (event.kind) {
      case "treeReady":
        await this.loadTree(roomUid);
        return;
      case "treeDelta": {
        const next = applyDelta(this.room(roomUid).tree, event);
        if (next === null) {
          await this.loadTree(roomUid);
          return;
        }
        this.update(roomUid, { tree: next });
        this.afterDelta(roomUid, event.upserts, event.removed);
        return;
      }
      case "treeStale":
        this.update(roomUid, { tree: { ...this.room(roomUid).tree, ready: false } });
        return;
      case "progress":
        if (this.room(roomUid).loading.has(event.file)) {
          this.setLoading(roomUid, event.file, { received: event.received, total: event.total });
        }
        return;
    }
  }

  private netEvent(payload: NetEventPayload): void {
    if (payload.side !== "participant" || payload.event.kind !== "state") return;
    if (!FINISHED.has(payload.event.state)) return;
    this.update(payload.roomUid, {
      connected: false,
      loading: new Map(),
      tree: { ...this.room(payload.roomUid).tree, ready: false },
    });
    for (const [uri, opened] of this.opened) {
      if (opened.roomUid === payload.roomUid) this.host.markDocument(uri, "unavailable");
    }
  }

  private afterDelta(
    roomUid: string,
    upserts: readonly ManifestEntry[],
    removed: readonly string[],
  ): void {
    const gone = new Set(removed);
    const changed = new Map(upserts.map((entry) => [entry.id, entry]));
    for (const [uri, opened] of this.opened) {
      if (opened.roomUid !== roomUid) continue;
      if (gone.has(opened.fileId)) {
        this.host.markDocument(uri, "unavailable");
        continue;
      }
      const entry = changed.get(opened.fileId);
      if (entry) this.host.renamed?.(uri, entry.path);
      const live = this.host.isLive?.(uri) ?? false;
      if (
        entry &&
        !live &&
        (entry.size !== opened.size || entry.modifiedMs !== opened.modifiedMs)
      ) {
        this.host.markDocument(uri, "stale");
      }
    }
    this.pruneView(roomUid);
  }

  /** After a full tree read: opened files missing from it are unavailable, ones with new stats stale. */
  private reconcileOpened(roomUid: string): void {
    const tree = this.room(roomUid).tree;
    for (const [uri, opened] of this.opened) {
      if (opened.roomUid !== roomUid) continue;
      const entry = tree.entries.get(opened.fileId);
      if (!entry) this.host.markDocument(uri, "unavailable");
      else if (entry.size !== opened.size || entry.modifiedMs !== opened.modifiedMs)
        this.host.markDocument(uri, "stale");
    }
    this.pruneView(roomUid);
  }

  /** Expanded/selected ids that left the tree are dropped (an id is never reused for another file). */
  private pruneView(roomUid: string): void {
    const room = this.room(roomUid);
    const expanded = new Set([...room.expanded].filter((id) => room.tree.entries.has(id)));
    const selected =
      room.selected !== null && room.tree.entries.has(room.selected) ? room.selected : null;
    if (expanded.size !== room.expanded.size || selected !== room.selected)
      this.update(roomUid, { expanded, selected });
  }

  private setLoading(
    roomUid: string,
    fileId: string,
    value: { received: number; total: number } | null,
  ): void {
    const loading = new Map(this.room(roomUid).loading);
    if (value === null) loading.delete(fileId);
    else loading.set(fileId, value);
    this.update(roomUid, { loading });
  }

  private update(roomUid: string, change: Partial<RemoteRoomState>): void {
    this.rooms.set(roomUid, { ...this.room(roomUid), ...change });
    for (const listener of this.listeners) listener();
  }
}
