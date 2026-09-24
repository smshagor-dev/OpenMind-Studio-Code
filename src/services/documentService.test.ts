import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { OpenedDocument } from "./ipc";

const OPENED: OpenedDocument = {
  path: "C:/proj/main.rs",
  content: "fn main() {}",
  encoding: "utf8",
  lineEnding: "lf",
};

describe("DocumentService", () => {
  let buffers: BufferManager;
  let events: EventBus<AppEvents>;

  beforeEach(() => {
    buffers = new BufferManager();
    events = new EventBus<AppEvents>();
  });

  it("createUntitled starts a clean, unnamed document", () => {
    const service = new DocumentService(createFakeIpc(), buffers, events);

    const id = service.createUntitled();
    const snapshot = service.snapshot(id);

    expect(snapshot.path).toBeNull();
    expect(snapshot.title).toBe("Untitled");
    expect(snapshot.dirty).toBe(false);
  });

  it("openFromPath reads the file via IPC and creates a clean document", async () => {
    const ipc = createFakeIpc({ documentOpen: vi.fn().mockResolvedValue(OPENED) });
    const service = new DocumentService(ipc, buffers, events);

    const id = await service.openFromPath(OPENED.path);
    const snapshot = service.snapshot(id);

    expect(ipc.documentOpen).toHaveBeenCalledWith(OPENED.path);
    expect(snapshot.path).toBe(OPENED.path);
    expect(snapshot.title).toBe("main.rs");
    expect(snapshot.dirty).toBe(false);
    expect(buffers.getValue(id)).toBe(OPENED.content);
  });

  it("openFromPath reuses the existing document instead of reopening", async () => {
    const ipc = createFakeIpc({ documentOpen: vi.fn().mockResolvedValue(OPENED) });
    const service = new DocumentService(ipc, buffers, events);

    const first = await service.openFromPath(OPENED.path);
    const second = await service.openFromPath(OPENED.path);

    expect(second).toBe(first);
    expect(ipc.documentOpen).toHaveBeenCalledTimes(1);
  });

  it("editing the buffer marks the document dirty and emits an event", () => {
    const service = new DocumentService(createFakeIpc(), buffers, events);
    const id = service.createUntitled();
    const dirtyChanges: boolean[] = [];
    events.on("documentDirtyChanged", (payload) => dirtyChanges.push(payload.dirty));

    buffers.setValue(id, "new content");

    expect(service.isDirty(id)).toBe(true);
    expect(dirtyChanges).toEqual([true]);
  });

  it("save() on a document with a path writes via IPC and clears dirty", async () => {
    const ipc = createFakeIpc({ documentOpen: vi.fn().mockResolvedValue(OPENED) });
    const service = new DocumentService(ipc, buffers, events);
    const id = await service.openFromPath(OPENED.path);
    buffers.setValue(id, "changed");

    await service.save(id);

    expect(ipc.documentSave).toHaveBeenCalledWith(OPENED.path, "changed", "utf8");
    expect(service.isDirty(id)).toBe(false);
  });

  it("save() on an untitled document delegates to saveAs", async () => {
    const ipc = createFakeIpc({ saveDocumentDialog: vi.fn().mockResolvedValue("C:/new.txt") });
    const service = new DocumentService(ipc, buffers, events);
    const id = service.createUntitled();
    buffers.setValue(id, "hello");

    await service.save(id);

    expect(ipc.saveDocumentDialog).toHaveBeenCalled();
    expect(ipc.documentSave).toHaveBeenCalledWith("C:/new.txt", "hello", "utf8");
    expect(service.snapshot(id).path).toBe("C:/new.txt");
    expect(service.isDirty(id)).toBe(false);
  });

  it("saveAs() does nothing when the dialog is cancelled", async () => {
    const ipc = createFakeIpc({ saveDocumentDialog: vi.fn().mockResolvedValue(null) });
    const service = new DocumentService(ipc, buffers, events);
    const id = service.createUntitled();
    buffers.setValue(id, "hello");

    await service.saveAs(id);

    expect(ipc.documentSave).not.toHaveBeenCalled();
    expect(service.snapshot(id).path).toBeNull();
  });

  it("close() disposes the buffer and forgets the document", () => {
    const service = new DocumentService(createFakeIpc(), buffers, events);
    const id = service.createUntitled();

    service.close(id);

    expect(buffers.get(id)).toBeUndefined();
    expect(() => service.snapshot(id)).toThrow(/does not exist/);
  });

  describe("line endings and the loaded baseline", () => {
    type Eol = OpenedDocument["lineEnding"];
    const CASES: [string, Eol, string][] = [
      ["LF", "lf", "a\nb\nc\n"],
      ["CRLF", "crlf", "a\r\nb\r\nc\r\n"],
      ["mixed", "mixed", "a\r\nb\nc\r\nd\n"],
    ];

    async function open(content: string, lineEnding: Eol) {
      const ipc = createFakeIpc({
        documentOpen: vi.fn().mockResolvedValue({ ...OPENED, content, lineEnding }),
      });
      const service = new DocumentService(ipc, buffers, events);
      const id = await service.openFromPath(OPENED.path);
      return { ipc, service, id };
    }

    it.each(CASES)(
      "%s file opens clean and keeps its reported line ending",
      async (_n, eol, text) => {
        const { service, id } = await open(text, eol);
        expect(service.snapshot(id).dirty).toBe(false);
        expect(service.snapshot(id).lineEnding).toBe(eol);
      },
    );

    it.each(CASES)(
      "%s file: an edit is dirty, undoing it is clean again",
      async (_n, eol, text) => {
        const { service, id } = await open(text, eol);
        const model = buffers.get(id);
        if (!model) throw new Error("no model");
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: "x" }], () => null);
        expect(service.isDirty(id)).toBe(true);
        void model.undo();
        expect(service.isDirty(id)).toBe(false);
      },
    );

    it("saving a mixed file without edits does not write it; after an edit it does and clears dirty", async () => {
      const { ipc, service, id } = await open("a\r\nb\nc\r\nd\n", "mixed");
      await service.save(id);
      expect(ipc.documentSave).not.toHaveBeenCalled();

      buffers.setValue(id, "edited");
      expect(service.isDirty(id)).toBe(true);
      await service.save(id);
      expect(ipc.documentSave).toHaveBeenCalledTimes(1);
      expect(service.isDirty(id)).toBe(false);
    });

    it("an external change to a clean mixed file reloads; with edits it is a conflict", async () => {
      const { ipc, service, id } = await open("a\r\nb\nc\r\nd\n", "mixed");
      const disk = {
        state: "file" as const,
        content: "new\nlines\n",
        encoding: "utf8" as const,
        lineEnding: "lf" as const,
      };
      vi.mocked(ipc.documentRead).mockResolvedValue(disk);
      expect(await service.checkDisk(id)).toBe("reloaded");
      expect(service.isDirty(id)).toBe(false);

      buffers.setValue(id, "my edit\n");
      vi.mocked(ipc.documentRead).mockResolvedValue({ ...disk, content: "other\n" });
      expect(await service.checkDisk(id)).toBe("conflict");
      expect(service.externalState(id)).toBe("changed");
      expect(service.contentOf(id)).toBe("my edit\n");
    });
  });
});
