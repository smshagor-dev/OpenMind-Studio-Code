import * as Y from "yjs";

import { TEXT_NAME } from "./collabBinding";
import { toBase64 } from "./collabDocIpc";
import type { DocChangeListener, LiveDoc } from "./collabDocService";
import type { LocalPresence, PresenceIpc } from "./presenceIpc";

/** Selection and cursor changes are gathered this long and sent as one state (the backend throttles again). */
export const PUBLISH_DELAY_MS = 40;
/** "Typing" ends this long after the last own change. */
export const TYPING_MS = 2000;
/** Re-sent while unchanged so other members don't expire it (they wait 30 s). */
export const HEARTBEAT_MS = 10_000;

/** The parts of a Monaco model and editor the publisher reads. */
export interface ModelLike {
  getOffsetAt: (position: { lineNumber: number; column: number }) => number;
}

export interface SelectionLike {
  selectionStartLineNumber: number;
  selectionStartColumn: number;
  positionLineNumber: number;
  positionColumn: number;
}

export interface EditorLike {
  getModel: () => ModelLike | null;
  getSelection: () => SelectionLike | null;
}

export interface PublisherHost {
  liveFor: (model: ModelLike) => LiveDoc | null;
  onDocChange: (listener: DocChangeListener) => () => void;
  /** Rooms this computer hosts (the Owner's own editor reports the path of an ordinary file there). */
  hostedRooms: () => readonly string[];
  /** An ordinary file's path on this computer (none for untitled, preview or remote documents). */
  pathOf: (model: ModelLike) => string | null;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

const EMPTY: LocalPresence = { active: null, path: null, cursor: null, typing: false };

/** A text offset as an encoded Yjs relative position (stays put when others edit before it). */
function relative(doc: Y.Doc, offset: number): string {
  const position = Y.createRelativePositionFromTypeIndex(doc.getText(TEXT_NAME), offset);
  return toBase64(Y.encodeRelativePosition(position));
}

/**
 * This window's presence (Milestone 24, phase 7): which shared file the focused editor shows — only the active one,
 * never every open tab —, its cursor and selection as Yjs relative positions, and whether its user is typing. One state
 * per room goes to the backend, which merges this computer's windows into one presence and sends it on.
 */
export class PresencePublisher {
  private editor: EditorLike | null = null;
  private sent = new Map<string, string>();
  private typingRoom: string | null = null;
  private typingTimer: unknown = null;
  private timer: unknown = null;
  private heartbeat: unknown = null;
  private stopChange: (() => void) | null = null;

  constructor(
    private readonly ipc: PresenceIpc,
    private readonly host: PublisherHost,
  ) {}

  start(): () => void {
    this.stopChange = this.host.onDocChange((roomUid, fileId, local) => {
      if (local) this.typed(roomUid, fileId);
    });
    this.beat();
    return () => {
      this.stopChange?.();
      for (const t of [this.timer, this.typingTimer, this.heartbeat])
        if (t !== null) this.host.clearTimer(t);
      this.timer = this.typingTimer = this.heartbeat = null;
    };
  }

  /** The editor the user is in now (focus moved, a tab switched). */
  focus(editor: EditorLike | null): void {
    this.editor = editor;
    this.soon();
  }

  /** An editor went away (closed group, disposed): if it was the user's, nothing is active now. */
  forget(editor: EditorLike): void {
    if (editor === this.editor) this.focus(null);
  }

  /**
   * An editor's cursor, selection or document changed. With no editor chosen yet (a file opened from the Explorer
   * leaves the focus there), the editor that shows something is the active one.
   */
  moved(editor: EditorLike): void {
    if (this.editor === null && editor.getModel() !== null) this.editor = editor;
    if (editor === this.editor) this.soon();
  }

  /** Something about the rooms changed (hosting started, a document became live): look again. */
  refresh(): void {
    this.soon();
  }

  /** What this window shows in each room now. */
  compute(): Map<string, LocalPresence> {
    const out = new Map<string, LocalPresence>();
    for (const room of this.sent.keys()) out.set(room, EMPTY);
    const model = this.editor?.getModel() ?? null;
    if (!model || !this.editor) return out;
    const live = this.host.liveFor(model);
    if (live) {
      const selection = this.editor.getSelection();
      const cursor = selection
        ? {
            anchor: relative(
              live.doc,
              model.getOffsetAt({
                lineNumber: selection.selectionStartLineNumber,
                column: selection.selectionStartColumn,
              }),
            ),
            head: relative(
              live.doc,
              model.getOffsetAt({
                lineNumber: selection.positionLineNumber,
                column: selection.positionColumn,
              }),
            ),
          }
        : null;
      const typing = this.typingRoom === live.roomUid;
      out.set(live.roomUid, { active: live.fileId, path: null, cursor, typing });
      return out;
    }
    const path = this.host.pathOf(model);
    if (path !== null)
      for (const room of this.host.hostedRooms()) out.set(room, { ...EMPTY, path });
    return out;
  }

  private soon(): void {
    this.timer ??= this.host.setTimer(() => {
      this.timer = null;
      this.publish(false);
    }, PUBLISH_DELAY_MS);
  }

  private publish(again: boolean): void {
    for (const [room, presence] of this.compute()) {
      const text = JSON.stringify(presence);
      const empty = presence.active === null && !presence.path;
      if (!again && this.sent.get(room) === text) continue;
      if (empty) this.sent.delete(room);
      else this.sent.set(room, text);
      void this.ipc.set(room, presence).catch(() => undefined);
    }
  }

  private typed(roomUid: string, fileId: string): void {
    const model = this.editor?.getModel() ?? null;
    const live = model ? this.host.liveFor(model) : null;
    if (!live || live.roomUid !== roomUid || live.fileId !== fileId) return;
    const was = this.typingRoom;
    this.typingRoom = roomUid;
    if (this.typingTimer !== null) this.host.clearTimer(this.typingTimer);
    this.typingTimer = this.host.setTimer(() => {
      this.typingTimer = null;
      this.typingRoom = null;
      this.soon();
    }, TYPING_MS);
    if (was !== roomUid) this.soon();
  }

  private beat(): void {
    this.heartbeat = this.host.setTimer(() => {
      this.publish(true);
      this.beat();
    }, HEARTBEAT_MS);
  }
}
