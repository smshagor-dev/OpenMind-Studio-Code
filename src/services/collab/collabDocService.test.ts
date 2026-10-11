import * as monaco from "monaco-editor";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { wasLive } from "../../editor/collabModels";
import { REMOTE, SEND_DELAY_MS } from "./collabBinding";
import {
  fromBase64,
  toBase64,
  type CollabDocIpc,
  type DocEventPayload,
  type DocNotice,
} from "./collabDocIpc";
import { CollabDocService, type CollabDocHost } from "./collabDocService";

// Real Yjs, real y-monaco and real Monaco models (plaintext: no language worker in jsdom). A fake backend plays the
// Owner with its own Y.Doc as the canonical document.

const ROOM = "0123456789abcdef0123456789abcdef";
const FILE = "b".repeat(32);
const URI = `omcollab://${ROOM}/${FILE}`;

class FakeOwner {
  canonical = new Y.Doc();
  sent: Uint8Array[] = [];
  connected = true;
  write = true;
  listener: (p: DocEventPayload) => void = () => undefined;

  constructor(text: string) {
    this.canonical.getText("content").insert(0, text);
  }

  emit(side: "host" | "participant", event: DocNotice): void {
    this.listener({ roomUid: ROOM, side, event });
  }

  /** Someone else's edit on the Owner's side, forwarded like the backend does. */
  remoteEdit(at: number, insert: string): void {
    const before = Y.encodeStateVector(this.canonical);
    this.canonical.getText("content").insert(at, insert);
    this.emit("participant", {
      kind: "update",
      fileId: FILE,
      update: toBase64(Y.encodeStateAsUpdate(this.canonical, before)),
    });
  }

  ipc(): CollabDocIpc {
    return {
      ownerState: vi.fn(() => Promise.resolve(toBase64(Y.encodeStateAsUpdate(this.canonical)))),
      ownerUpdate: vi.fn((_r: string, _f: string, update: string) => {
        this.sent.push(fromBase64(update));
        Y.applyUpdate(this.canonical, fromBase64(update), REMOTE);
        return Promise.resolve();
      }),
      ownerBind: vi.fn(() => Promise.resolve()),
      subscribe: vi.fn((_r: string, _f: string, sv: string) => {
        if (!this.connected) return Promise.reject(new Error("offline"));
        const update = Y.encodeStateAsUpdate(this.canonical, fromBase64(sv));
        queueMicrotask(() => {
          this.emit("participant", {
            kind: "sync",
            fileId: FILE,
            stateVector: toBase64(Y.encodeStateVector(this.canonical)),
            update: toBase64(update),
          });
        });
        return Promise.resolve();
      }),
      send: vi.fn((_r: string, _f: string, update: string) => {
        this.sent.push(fromBase64(update));
        if (this.connected && this.write) Y.applyUpdate(this.canonical, fromBase64(update), REMOTE);
        return Promise.resolve();
      }),
      unsubscribe: vi.fn(() => Promise.resolve()),
      onDoc: vi.fn((listener: (p: DocEventPayload) => void) => {
        this.listener = listener;
        return Promise.resolve(() => undefined);
      }),
    };
  }
}

const models: monaco.editor.ITextModel[] = [];

function model(text: string): monaco.editor.ITextModel {
  const m = monaco.editor.createModel(text, "plaintext");
  models.push(m);
  return m;
}

afterEach(() => {
  for (const m of models.splice(0)) m.dispose();
});

function host(shared: monaco.editor.ITextModel, overrides: Partial<CollabDocHost> = {}) {
  const live = new Map<string, boolean>();
  const h: CollabDocHost = {
    remoteModel: () => ({ model: shared, release: vi.fn() }),
    setLive: (uri, editable) => live.set(uri, editable),
    setUnavailable: vi.fn(),
    openHeld: () => Promise.resolve(null),
    releaseHeld: vi.fn(),
    keepApart: vi.fn(),
    error: (message) => {
      throw new Error(message);
    },
    ...overrides,
  };
  return { h, live };
}

/** Types into the model the way the editor does (an undoable edit). */
function type(m: monaco.editor.ITextModel, at: number, text: string): void {
  const pos = m.getPositionAt(at);
  m.pushEditOperations(
    [],
    [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text }],
    () => null,
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS + 20));
}

async function joined(
  owner: FakeOwner,
  shared: monaco.editor.ITextModel,
  overrides: Partial<CollabDocHost> = {},
) {
  const { h, live } = host(shared, overrides);
  const service = new CollabDocService(owner.ipc(), h);
  await service.start();
  await service.openRemote(ROOM, FILE, URI, "plaintext");
  await vi.waitFor(() => {
    expect(service.isLive(URI)).toBe(true);
  });
  return { service, live };
}

describe("CollabDocService (participant)", () => {
  it("binds the existing model, sends typing and applies others' edits without echoing them", async () => {
    const owner = new FakeOwner("hello\n");
    const shared = model("hello\n"); // the Phase 5 snapshot already in the tab's model
    await joined(owner, shared);
    expect(shared.getValue()).toBe("hello\n");
    type(shared, 5, " world");
    await settle();
    expect(owner.canonical.getText("content").toJSON()).toBe("hello world\n");
    const sentBefore = owner.sent.length;
    owner.remoteEdit(0, ">> ");
    await settle();
    expect(shared.getValue()).toBe(">> hello world\n");
    expect(owner.sent.length, "a remote edit is never sent back").toBe(sentBefore);
  });

  it("undo takes back only this user's own edits", async () => {
    const owner = new FakeOwner("abc");
    const shared = model("abc");
    await joined(owner, shared);
    type(shared, 3, "MINE");
    owner.remoteEdit(0, "THEIRS ");
    await settle();
    expect(shared.getValue()).toBe("THEIRS abcMINE");
    void shared.undo();
    expect(shared.getValue(), "the other user's edit stays").toBe("THEIRS abc");
    void shared.redo();
    expect(shared.getValue()).toBe("THEIRS abcMINE");
  });

  it("follows write access and resyncs after a refused change", async () => {
    const owner = new FakeOwner("abc");
    const shared = model("abc");
    const { live } = await joined(owner, shared);
    expect(live.get(URI), "read-only until the Owner says otherwise").toBe(false);
    owner.emit("participant", { kind: "access", write: true });
    expect(live.get(URI)).toBe(true);
    owner.write = false; // the Owner refuses from now on
    type(shared, 3, "!");
    await settle();
    owner.emit("participant", {
      kind: "rejected",
      fileId: FILE,
      reason: "Permission 'file.write' is missing.",
    });
    await vi.waitFor(() => {
      expect(shared.getValue()).toBe("abc");
    });
  });

  it("keeps typing through a disconnect and sends what the Owner lacks when it comes back", async () => {
    const owner = new FakeOwner("abc");
    const shared = model("abc");
    const { service } = await joined(owner, shared);
    owner.connected = false;
    type(shared, 3, " offline");
    await settle();
    expect(owner.canonical.getText("content").toJSON(), "not delivered while offline").toBe("abc");
    owner.remoteEdit(0, "owner ");
    await settle();
    owner.connected = true;
    await service.resync(ROOM);
    await vi.waitFor(() => {
      expect(owner.canonical.getText("content").toJSON()).toBe("owner abc offline");
    });
    expect(shared.getValue(), "both sides merged by the CRDT").toBe("owner abc offline");
  });

  it("DATA-LOSS REGRESSION (phases 6/10): a session loss and rejoin keep the Owner's and the participant's edits", async () => {
    // Owner has unsaved edit A, the participant edit B (acknowledged); then the session is lost while the tab still
    // carries its open-time snapshot, and the participant rejoins.
    const snapshot = "base\n";
    const owner = new FakeOwner(snapshot);
    const shared = model(snapshot);
    const { service } = await joined(owner, shared);
    type(shared, 0, "B ");
    await settle();
    owner.remoteEdit(0, "A ");
    await settle();
    expect(owner.canonical.getText("content").toJSON()).toBe("A B base\n");
    owner.connected = false;
    // The read-only view after the loss may only write its stale snapshot into a model that never followed the
    // live document; this one did, so the snapshot never comes back (VirtualTextPreview's guard).
    expect(wasLive(shared)).toBe(true);
    expect(shared.getValue()).toBe("A B base\n");
    owner.connected = true;
    await service.resync(ROOM);
    await settle();
    expect(owner.canonical.getText("content").toJSON(), "A and B survive on the Owner").toBe(
      "A B base\n",
    );
    expect(shared.getValue(), "and on the participant").toBe("A B base\n");
    expect(
      owner.sent.every((u) => {
        const probe = new Y.Doc();
        Y.applyUpdate(probe, Y.encodeStateAsUpdate(owner.canonical));
        const before = probe.getText("content").toJSON();
        Y.applyUpdate(probe, u);
        return probe.getText("content").toJSON() === before;
      }),
      "nothing the participant sent deletes anyone's text",
    ).toBe(true);
  });

  it("opens one document per file and leaves cleanly when deleted", async () => {
    const owner = new FakeOwner("abc");
    const shared = model("abc");
    const setUnavailable = vi.fn();
    const { service } = await joined(owner, shared, { setUnavailable });
    await service.openRemote(ROOM, FILE, URI, "plaintext");
    expect(service.open()).toHaveLength(1);
    owner.emit("participant", { kind: "closed", fileId: FILE, reason: "deleted" });
    expect(setUnavailable).toHaveBeenCalledWith(URI);
    expect(service.open()).toHaveLength(0);
    expect(service.isLive(URI)).toBe(false);
  });
});

describe("CollabDocService (Owner)", () => {
  it("unsaved Owner edits win; a clean document takes the shared text and becomes dirty", async () => {
    const owner = new FakeOwner("shared text");
    const buffer = model("my unsaved edit");
    const release = vi.fn();
    const ipc = owner.ipc();
    const service = new CollabDocService(
      ipc,
      host(buffer, {
        openHeld: () =>
          Promise.resolve({ docId: "d1", model: buffer, dirty: true, saved: "shared text" }),
        releaseHeld: release,
      }).h,
    );
    await service.start();
    owner.emit("host", { kind: "active", fileId: FILE, path: "C:/w/a.ts" });
    await vi.waitFor(() => {
      expect(service.open()).toHaveLength(1);
    });
    expect(owner.canonical.getText("content").toJSON()).toBe("my unsaved edit");
    expect(buffer.getValue()).toBe("my unsaved edit");
    // A participant's accepted change reaches the Owner's buffer (which then is dirty and saved the usual way).
    const before = Y.encodeStateVector(owner.canonical);
    owner.canonical.getText("content").insert(0, "P: ");
    owner.emit("host", {
      kind: "update",
      fileId: FILE,
      update: toBase64(Y.encodeStateAsUpdate(owner.canonical, before)),
    });
    expect(buffer.getValue()).toBe("P: my unsaved edit");
    owner.emit("host", { kind: "closed", fileId: FILE, reason: "deleted" });
    expect(release).toHaveBeenCalledWith("d1");

    const clean = new FakeOwner("from the room");
    const saved = model("on disk");
    const second = new CollabDocService(
      clean.ipc(),
      host(saved, {
        openHeld: () => Promise.resolve({ docId: "d2", model: saved, dirty: false, saved: "" }),
      }).h,
    );
    await second.start();
    clean.emit("host", { kind: "active", fileId: FILE, path: "C:/w/b.ts" });
    await vi.waitFor(() => {
      expect(saved.getValue()).toBe("from the room");
    });
    type(saved, 0, "owner: ");
    await settle();
    expect(clean.canonical.getText("content").toJSON()).toBe("owner: from the room");
  });

  it("after an Owner crash, edits typed before the shared document loads join it; accepted ones are never lost", async () => {
    // The stored document recovered accepted, unsaved changes; the restarted editor opened the file from disk.
    const disk = "export function greet() {}\n";
    const owner = new FakeOwner(`${disk}// Ana's accepted change\n`);
    const buffer = model(disk);
    type(buffer, 0, "Apost ");
    const service = new CollabDocService(
      owner.ipc(),
      host(buffer, {
        openHeld: () => Promise.resolve({ docId: "d1", model: buffer, dirty: true, saved: disk }),
      }).h,
    );
    await service.start();
    owner.emit("host", { kind: "active", fileId: FILE, path: "C:/w/a.ts" });
    await vi.waitFor(() => {
      expect(service.open()).toHaveLength(1);
    });
    const both = `Apost ${disk}// Ana's accepted change\n`;
    expect(owner.canonical.getText("content").toJSON()).toBe(both);
    expect(buffer.getValue()).toBe(both);
  });

  it("keeps the Owner's overlapping edits apart and the accepted shared text in the editor", async () => {
    const disk = "return name;";
    const owner = new FakeOwner("return `Hi ${name}`;");
    const buffer = model("return name.trim();");
    const keepApart = vi.fn();
    const service = new CollabDocService(
      owner.ipc(),
      host(buffer, {
        openHeld: () => Promise.resolve({ docId: "d1", model: buffer, dirty: true, saved: disk }),
        keepApart,
      }).h,
    );
    await service.start();
    owner.emit("host", { kind: "active", fileId: FILE, path: "C:/w/a.ts" });
    await vi.waitFor(() => {
      expect(service.open()).toHaveLength(1);
    });
    expect(keepApart).toHaveBeenCalledWith("C:/w/a.ts", "return name.trim();");
    expect(owner.canonical.getText("content").toJSON()).toBe("return `Hi ${name}`;");
    expect(buffer.getValue()).toBe("return `Hi ${name}`;");
  });
});
