import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { TEXT_NAME } from "../services/collab/collabBinding";
import type { LiveDoc } from "../services/collab/collabDocService";
import type { LocalPresence, PresenceIpc } from "../services/collab/presenceIpc";
import {
  PresencePublisher,
  TYPING_MS,
  type EditorLike,
  type ModelLike,
} from "../services/collab/presencePublisher";
import type { PeerPresence } from "../services/collab/presenceService";
import {
  RemoteCursors,
  cssString,
  resolve,
  type CursorEditor,
  type Decoration,
} from "./remoteCursors";

/** A tiny text model over a Y.Text (offsets <-> line/column the way Monaco counts: UTF-16 units). */
function modelOf(doc: Y.Doc): ModelLike & {
  getPositionAt: (o: number) => { lineNumber: number; column: number };
  getValueLength: () => number;
} {
  const text = () => doc.getText(TEXT_NAME).toJSON();
  return {
    getValueLength: () => text().length,
    getOffsetAt: ({ lineNumber, column }) => {
      const lines = text().split("\n");
      let offset = 0;
      for (let i = 0; i < lineNumber - 1; i += 1) offset += (lines[i]?.length ?? 0) + 1;
      return offset + column - 1;
    },
    getPositionAt: (o) => {
      const before = text().slice(0, o).split("\n");
      return { lineNumber: before.length, column: (before[before.length - 1]?.length ?? 0) + 1 };
    },
  };
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

class Timers {
  queue: { id: number; run: () => void; ms: number }[] = [];
  private n = 1;
  set = (run: () => void, ms: number): unknown => {
    const id = this.n++;
    this.queue.push({ id, run, ms });
    return id;
  };
  clear = (t: unknown): void => {
    this.queue = this.queue.filter((x) => x.id !== t);
  };
  /** Runs every pending timer of at most `ms` (once). */
  run(ms: number): void {
    const due = this.queue.filter((x) => x.ms <= ms);
    this.queue = this.queue.filter((x) => x.ms > ms);
    for (const t of due) t.run();
  }
}

function setup(text: string) {
  const mine = new Y.Doc();
  mine.getText(TEXT_NAME).insert(0, text);
  const theirs = new Y.Doc();
  sync(mine, theirs);
  const model = modelOf(mine);
  const live: LiveDoc = {
    roomUid: "r",
    fileId: "f",
    side: "participant",
    doc: mine,
    model: model as unknown as LiveDoc["model"],
  };
  const sent: [string, LocalPresence][] = [];
  const ipc: PresenceIpc = {
    set: (room, p) => {
      sent.push([room, p]);
      return Promise.resolve();
    },
    snapshot: () => Promise.reject(new Error("unused")),
    onPresence: () => Promise.resolve(() => undefined),
  };
  let changeListener: ((r: string, f: string, local: boolean) => void) | null = null;
  const timers = new Timers();
  const publisher = new PresencePublisher(ipc, {
    liveFor: (m) => (m === model ? live : null),
    onDocChange: (l) => {
      changeListener = l;
      return () => undefined;
    },
    hostedRooms: () => ["hosted"],
    pathOf: () => null,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  publisher.start();
  const editor = (anchor: number, head: number): EditorLike => {
    const a = model.getPositionAt(anchor);
    const h = model.getPositionAt(head);
    return {
      getModel: () => model,
      getSelection: () => ({
        selectionStartLineNumber: a.lineNumber,
        selectionStartColumn: a.column,
        positionLineNumber: h.lineNumber,
        positionColumn: h.column,
      }),
    };
  };
  return {
    mine,
    theirs,
    model,
    live,
    sent,
    timers,
    publisher,
    editor,
    local: () => changeListener,
  };
}

/** What the other side shows for the last presence `s.sent` holds, drawn in a model of `doc`. */
function draw(doc: Y.Doc, presence: LocalPresence, typing = false): Decoration[] {
  const model = modelOf(doc);
  const decorations: Decoration[] = [];
  const set = {
    set: (d: Decoration[]) => decorations.splice(0, decorations.length, ...d),
    clear: vi.fn(),
  };
  const peer: PeerPresence = {
    peer: "p1",
    state: { seq: 1, active: presence.active, cursor: presence.cursor, typing },
    activePath: null,
    at: 0,
  };
  const live = {
    roomUid: "r",
    fileId: "f",
    side: "host" as const,
    doc,
    model: model as unknown as LiveDoc["model"],
  };
  const cursors = new RemoteCursors(
    { liveFor: () => live, peers: () => [peer], nameOf: () => "Ana" },
    { set: () => undefined },
  );
  const editor: CursorEditor = { getModel: () => model, createDecorationsCollection: () => set };
  cursors.attach(editor);
  return decorations;
}

describe("presence cursors", () => {
  it("publishes only the active file, with the selection as relative positions", () => {
    const s = setup("hello world");
    s.publisher.focus(s.editor(0, 5));
    s.timers.run(40);
    expect(s.sent).toHaveLength(1);
    const [room, presence] = s.sent[0] ?? ["", null];
    expect(room).toBe("r");
    expect(presence).toMatchObject({ active: "f", typing: false });
    const caret = draw(s.theirs, presence as LocalPresence);
    expect(caret.map((d) => d.range)).toEqual([
      { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
      { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 6 },
    ]);
  });

  it("keeps a cursor on its character across concurrent edits and emoji", () => {
    const s = setup("ab😀cd\nline two");
    // Cursor right after the emoji (offset 4: a, b and two UTF-16 units).
    s.publisher.focus(s.editor(4, 4));
    s.timers.run(40);
    const presence = s.sent[0]?.[1] as LocalPresence;
    // Meanwhile the other side inserts text (with an emoji) before the cursor and deletes after it.
    s.theirs.getText(TEXT_NAME).insert(0, "🎉 new ");
    s.theirs.getText(TEXT_NAME).delete(11, 1); // the "c" the cursor sat before
    const caret = draw(s.theirs, presence);
    const text = s.theirs.getText(TEXT_NAME).toJSON();
    const head = caret[caret.length - 1]?.range;
    const offset = modelOf(s.theirs).getOffsetAt({
      lineNumber: head?.startLineNumber ?? 0,
      column: head?.startColumn ?? 0,
    });
    expect(text.slice(0, offset).endsWith("😀")).toBe(true);
    // Never between the halves of a surrogate pair.
    const code = text.charCodeAt(offset);
    expect(code >= 0xdc00 && code < 0xe000).toBe(false);
  });

  it("sends nothing for an unchanged cursor, marks typing and lets it end", () => {
    const s = setup("abc");
    const editor = s.editor(1, 1);
    s.publisher.focus(editor);
    s.timers.run(40);
    s.publisher.moved(editor);
    s.timers.run(40);
    expect(s.sent).toHaveLength(1);
    s.local()?.("r", "f", true);
    s.timers.run(40);
    expect(s.sent.at(-1)?.[1].typing).toBe(true);
    s.timers.run(TYPING_MS);
    s.timers.run(40);
    expect(s.sent.at(-1)?.[1].typing).toBe(false);
  });

  it("clears the room it left when the user switches to a file that isn't shared", () => {
    const s = setup("abc");
    s.publisher.focus(s.editor(0, 0));
    s.timers.run(40);
    s.publisher.focus({ getModel: () => ({ getOffsetAt: () => 0 }), getSelection: () => null });
    s.timers.run(40);
    expect(s.sent.at(-1)).toEqual(["r", { active: null, path: null, cursor: null, typing: false }]);
    s.publisher.focus(null);
    s.timers.run(40);
    expect(s.sent).toHaveLength(2);
  });

  it("re-sends the current state as a heartbeat", () => {
    const s = setup("abc");
    s.publisher.focus(s.editor(0, 0));
    s.timers.run(40);
    s.timers.run(10_000);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]?.[1]).toEqual(s.sent[0]?.[1]);
  });

  it("reuses one decoration collection per editor and clears it when nobody is there", () => {
    const doc = new Y.Doc();
    doc.getText(TEXT_NAME).insert(0, "abc");
    const model = modelOf(doc);
    const live = {
      roomUid: "r",
      fileId: "f",
      side: "host" as const,
      doc,
      model: model as unknown as LiveDoc["model"],
    };
    let peers: PeerPresence[] = [];
    const css: string[] = [];
    const cursors = new RemoteCursors(
      { liveFor: () => live, peers: () => peers, nameOf: () => 'Ana "A" \\ <b>' },
      { set: (c) => css.push(c) },
    );
    const set = { set: vi.fn<(d: Decoration[]) => void>(), clear: vi.fn() };
    const create = vi.fn(() => set);
    cursors.attach({ getModel: () => model, createDecorationsCollection: create });
    const rel = Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(doc.getText(TEXT_NAME), 2),
    );
    const anchor = btoa(String.fromCharCode(...rel));
    const here: PeerPresence = {
      peer: "x",
      state: { seq: 1, active: "f", cursor: { anchor, head: anchor }, typing: true },
      activePath: null,
      at: 0,
    };
    peers = [here];
    cursors.render();
    cursors.render();
    expect(create).toHaveBeenCalledTimes(1);
    expect(set.set).toHaveBeenCalledTimes(2);
    const options = set.set.mock.calls[0]?.[0]?.[0]?.options as Decoration["options"];
    expect(options.beforeContentClassName).toMatch(
      /collab-caret collab-fg-\d collab-label-1 collab-caret--typing/,
    );
    expect(css.at(-1)).toBe('.collab-label-1::after{content:"Ana \\"A\\" \\\\ <b>";}');
    peers = [{ ...here, state: { ...here.state, active: "other" } }];
    cursors.render();
    expect(set.clear).toHaveBeenCalled();
    expect(css).toHaveLength(1);
  });

  it("ignores malformed positions instead of throwing", () => {
    const doc = new Y.Doc();
    expect(resolve(doc, "!!not base64")).toBeNull();
    expect(resolve(doc, btoa("\u0001\u0002"))).toBeNull();
    expect(cssString("a\u0007b")).toBe('"ab"');
  });
});
