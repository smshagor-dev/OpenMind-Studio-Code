import type * as monaco from "monaco-editor";
import * as Y from "yjs";

import { CollabBinding, REMOTE, setText } from "./collabBinding";
import { mergeOwnerText } from "./ownerMerge";
import { fromBase64, toBase64, type CollabDocIpc, type DocEventPayload } from "./collabDocIpc";

/** What the service needs from the workbench (wired in `collabWiring.ts`). */
export interface CollabDocHost {
  /** Participant: the shared model of an `omcollab:` document (the same one its tab shows). */
  remoteModel: (
    uri: string,
    language: string,
  ) => { model: monaco.editor.ITextModel; release: () => void };
  /** Participant: the tab follows the live document; `editable` while this member may change files. */
  setLive: (uri: string, editable: boolean) => void;
  setUnavailable: (uri: string) => void;
  /** Owner: the editor document of a file on this computer, kept open (even without a tab) while followed. */
  openHeld: (path: string) => Promise<{
    docId: string;
    model: monaco.editor.ITextModel;
    dirty: boolean;
    /** The saved text the editor's unsaved edits are relative to. */
    saved: string;
  } | null>;
  releaseHeld: (docId: string) => void;
  /** Owner: keeps `text` apart (a new unsaved tab) when it couldn't be merged into the shared document of `path`. */
  keepApart: (path: string, text: string) => void;
  error: (message: string) => void;
}

interface Session {
  roomUid: string;
  fileId: string;
  side: "host" | "participant";
  doc: Y.Doc;
  binding: CollabBinding | null;
  /** The bound model (participant: the `omcollab:` tab's; Owner: its own editor document's). */
  model?: monaco.editor.ITextModel;
  /** Participant: the tab's identity and the model holder's release. */
  uri?: string;
  releaseModel?: () => void;
  /** Owner: the held editor document. */
  docId?: string;
}

const key = (roomUid: string, fileId: string): string => `${roomUid}/${fileId}`;

/** A live collaborative document as presence sees it. */
export interface LiveDoc {
  roomUid: string;
  fileId: string;
  side: "host" | "participant";
  doc: Y.Doc;
  model: monaco.editor.ITextModel;
}

export type DocChangeListener = (roomUid: string, fileId: string, local: boolean) => void;

/**
 * Collaborative editing in this window (Milestone 24, phase 6): one Yjs document per open file, bound to the existing
 * Monaco model — the participant's `omcollab://<room>/<file>` model, the Owner's own editor document — never a second
 * model. The Owner's computer holds the canonical document (`yrs`); this side syncs with it by state vectors, sends
 * its own changes (merged per [`SEND_DELAY_MS`]) and applies others' without echoing them back.
 *
 * - Participant: the document stays bound through a short outage (typing goes on; changes wait in the outbox); once the
 *   session has ended it is read-only and keeps the shared text (never the old snapshot) until the rejoin, and is
 *   synced again on reconnect, both ways; a refused change resyncs from the Owner; `access` toggles read-only at once
 *   (the Owner checks every change itself anyway).
 * - Owner: when a participant opens a file, the Owner's editor document for it is held open and bound. If it has
 *   unsaved edits they win (sent as one Owner change); otherwise the shared document wins and the editor document
 *   becomes dirty. Saving is the editor's usual Save/Auto Save — nothing here writes files.
 */
export class CollabDocService {
  private sessions = new Map<string, Session>();
  private access = new Map<string, boolean>();
  /** Owner documents being set up (two quick `active` events must not bind twice). */
  private following = new Set<string>();
  private changeListeners = new Set<DocChangeListener>();

  constructor(
    private readonly ipc: CollabDocIpc,
    private readonly host: CollabDocHost,
  ) {}

  async start(): Promise<() => void> {
    return this.ipc.onDoc((payload) => {
      void this.onEvent(payload).catch((err: unknown) => {
        this.host.error(String(err));
      });
    });
  }

  /** The live document a Monaco model shows, if it is one (the doc can be replaced: look it up each time). */
  liveFor(model: monaco.editor.ITextModel): LiveDoc | null {
    for (const s of this.sessions.values()) {
      if (s.binding !== null && s.model === model)
        return { roomUid: s.roomUid, fileId: s.fileId, side: s.side, doc: s.doc, model };
    }
    return null;
  }

  /** The live document of `fileId` in `roomUid`, if this window has it. */
  live(roomUid: string, fileId: string): LiveDoc | null {
    const s = this.sessions.get(key(roomUid, fileId));
    return s?.binding && s.model
      ? { roomUid, fileId, side: s.side, doc: s.doc, model: s.model }
      : null;
  }

  /** Every change of a live document (and a document becoming live or going away: `local` false). */
  onChange(listener: DocChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private changed(session: Session, local: boolean): void {
    for (const listener of [...this.changeListeners])
      listener(session.roomUid, session.fileId, local);
  }

  /** Whether an `omcollab:` document is live (its text follows the CRDT, not snapshots). */
  isLive(uri: string): boolean {
    return [...this.sessions.values()].some((s) => s.uri === uri && s.binding !== null);
  }

  /** Participant: makes an opened remote text document collaborative. */
  async openRemote(roomUid: string, fileId: string, uri: string, language: string): Promise<void> {
    if (this.sessions.has(key(roomUid, fileId))) return;
    const { model, release } = this.host.remoteModel(uri, language);
    const session: Session = {
      roomUid,
      fileId,
      side: "participant",
      doc: new Y.Doc(),
      binding: null,
      uri,
      model,
      releaseModel: release,
    };
    this.sessions.set(key(roomUid, fileId), session);
    await this.ipc.subscribe(roomUid, fileId, toBase64(Y.encodeStateVector(session.doc)));
  }

  /** Participant: the tab closed. */
  closeRemote(uri: string): void {
    const session = [...this.sessions.values()].find((s) => s.uri === uri);
    if (!session) return;
    this.drop(session);
    void this.ipc.unsubscribe(session.roomUid, session.fileId).catch(() => undefined);
  }

  /** Participant: the room is reachable again — every open document syncs both ways (missing changes either side). */
  async resync(roomUid: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.roomUid !== roomUid || session.side !== "participant") continue;
      await this.ipc.subscribe(roomUid, session.fileId, toBase64(Y.encodeStateVector(session.doc)));
    }
  }

  private drop(session: Session): void {
    session.binding?.destroy();
    session.binding = null;
    session.releaseModel?.();
    if (session.docId !== undefined) this.host.releaseHeld(session.docId);
    this.sessions.delete(key(session.roomUid, session.fileId));
    this.changed(session, false);
  }

  private async onEvent({ roomUid, side, event }: DocEventPayload): Promise<void> {
    if (event.kind === "access") {
      this.access.set(roomUid, event.write);
      for (const s of this.sessions.values()) {
        if (s.roomUid === roomUid && s.uri && s.binding) this.host.setLive(s.uri, event.write);
      }
      return;
    }
    if (side === "host" && event.kind === "active") {
      await this.followAsOwner(roomUid, event.fileId, event.path);
      return;
    }
    const session = this.sessions.get(key(roomUid, event.fileId));
    if (!session) return;
    switch (event.kind) {
      case "sync":
        this.synced(session, fromBase64(event.update), fromBase64(event.stateVector));
        return;
      case "update":
        session.binding?.applyRemote(fromBase64(event.update));
        return;
      case "closed":
        if (session.uri) this.host.setUnavailable(session.uri);
        if (session.side === "host")
          void this.ipc.ownerBind(roomUid, event.fileId, false).catch(() => undefined);
        this.drop(session);
        return;
      case "rejected":
        // Refused (no permission any more, deleted ...): start again from the Owner's document.
        session.binding?.destroy();
        session.binding = null;
        session.doc = new Y.Doc();
        await this.ipc.subscribe(roomUid, event.fileId, toBase64(Y.encodeStateVector(session.doc)));
        return;
    }
  }

  /** Participant: the Owner's answer to opening (or re-opening after a reconnect). */
  private synced(session: Session, update: Uint8Array, ownerStateVector: Uint8Array): void {
    if (session.binding) {
      session.binding.applyRemote(update);
    } else if (session.model) {
      Y.applyUpdate(session.doc, update, REMOTE);
      const { roomUid, fileId } = session;
      session.binding = new CollabBinding(
        session.doc,
        session.model,
        (u) => {
          void this.ipc.send(roomUid, fileId, toBase64(u)).catch((err: unknown) => {
            this.host.error(String(err));
          });
        },
        (local) => {
          this.changed(session, local);
        },
      );
      this.changed(session, false);
      if (session.uri) this.host.setLive(session.uri, this.access.get(roomUid) ?? false);
    }
    // What the Owner lacks (changes made here while disconnected): sent back as one update.
    const missing = Y.encodeStateAsUpdate(session.doc, ownerStateVector);
    if (missing.length > 2)
      void this.ipc.send(session.roomUid, session.fileId, toBase64(missing)).catch(() => undefined);
  }

  /** Owner: a participant opened a file of this computer; the Owner's editor document joins the shared document. */
  private async followAsOwner(roomUid: string, fileId: string, path: string): Promise<void> {
    const id = key(roomUid, fileId);
    if (this.sessions.has(id) || this.following.has(id)) return;
    this.following.add(id);
    try {
      await this.bindOwner(roomUid, fileId, path);
    } finally {
      this.following.delete(id);
    }
  }

  private async bindOwner(roomUid: string, fileId: string, path: string): Promise<void> {
    const held = await this.host.openHeld(path);
    if (!held) return;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fromBase64(await this.ipc.ownerState(roomUid, fileId)), REMOTE);
    const send = (u: Uint8Array): void => {
      void this.ipc.ownerUpdate(roomUid, fileId, toBase64(u)).catch((err: unknown) => {
        this.host.error(String(err));
      });
    };
    const current = held.model.getValue();
    if (held.dirty) {
      // Nothing typed is lost (ownerMerge): the editor's own edits join the shared document as one Owner change where
      // they can; overlapping ones are kept apart and the shared document (with accepted changes) stays.
      const plan = mergeOwnerText(held.saved, current, doc.getText("content").toJSON());
      if (plan.kind === "useText") {
        const before = Y.encodeStateVector(doc);
        setText(doc, plan.text);
        send(Y.encodeStateAsUpdate(doc, before));
      } else if (plan.kind === "conflict") {
        this.host.keepApart(path, current);
      }
    }
    const session: Session = {
      roomUid,
      fileId,
      side: "host",
      doc,
      binding: null,
      docId: held.docId,
      model: held.model,
    };
    session.binding = new CollabBinding(doc, held.model, send, (local) => {
      this.changed(session, local);
    });
    this.sessions.set(key(roomUid, fileId), session);
    this.changed(session, false);
    await this.ipc.ownerBind(roomUid, fileId, true);
  }

  /** Test and teardown helper: everything this window follows. */
  open(): { roomUid: string; fileId: string; side: string; live: boolean }[] {
    return [...this.sessions.values()].map((s) => ({
      roomUid: s.roomUid,
      fileId: s.fileId,
      side: s.side,
      live: s.binding !== null,
    }));
  }
}
