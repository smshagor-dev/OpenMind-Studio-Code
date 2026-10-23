import { expect, it, vi } from "vitest";
import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { BufferManager } from "./bufferManager";
import { DocumentService } from "./documentService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { HostDocumentSync, SELECTION_DELAY_MS, type HostEditorInfo } from "./extensionHostSync";

it("mirrors visible panes on startup, focus, scroll, overlay and teardown without manufacturing a text editor", async () => {
 vi.useFakeTimers();
 const buffers = new BufferManager(), events = new EventBus<AppEvents>();
 const docs = new DocumentService(createFakeIpc({ documentOpen: () => Promise.resolve({ path: "C:/work/shared.txt", content: "one\ntwo", encoding: "utf8", lineEnding: "lf" }) }), buffers, events);
 const docId = await docs.openFromPath("C:/work/shared.txt");
 const make = (id: string, viewColumn: number, active: boolean): HostEditorInfo => ({ id, viewColumn, active, path: "C:/work/shared.txt", tabSize: 4, insertSpaces: true, selections: [], visibleRanges: [] });
 let editors = [make("left", 1, true), make("right", 2, false)], covered = false;
 const listeners = new Set<() => void>(), sent: { method: string; params: unknown }[] = [];
 const sync = new HostDocumentSync({ documents: docs, events, visibleEditors: () => editors, currentActiveId: () => docId, editorsCovered: () => covered,
   onSelectionChange: listener => { listeners.add(listener); return () => listeners.delete(listener); }, notify: (method, params) => sent.push({ method, params }) });
 try {
  const initial = sync.initial(); expect(initial.visibleEditors).toHaveLength(2); expect(initial.activeEditor?.id).toBe("left"); sync.start();
  expect(sent.at(-1)).toMatchObject({ method: "host/editorSnapshot", params: { activeId: "left" } });
  editors = [make("left", 1, false), { ...make("right", 2, true), visibleRanges: [{ startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 }] }];
  for (const listener of listeners) listener(); vi.advanceTimersByTime(SELECTION_DELAY_MS + 1);
  expect(sent.at(-1)).toEqual({ method: "host/editorSnapshot", params: { editors, activeId: "right" } });
  const count = sent.length; for (const listener of listeners) listener(); vi.advanceTimersByTime(SELECTION_DELAY_MS + 1); expect(sent).toHaveLength(count);
  covered = true; sync.refreshActive(); expect(sent.at(-1)).toEqual({ method: "host/editorSnapshot", params: { editors: [], activeId: null } });
  covered = false; sync.refreshActive(); expect(sent.at(-1)).toMatchObject({ method: "host/editorSnapshot", params: { activeId: "right" } });
  editors = []; for (const listener of listeners) listener(); vi.advanceTimersByTime(SELECTION_DELAY_MS + 1);
  expect(sent.at(-1)).toEqual({ method: "host/editorSnapshot", params: { editors: [], activeId: null } });
 } finally { sync.stop(); buffers.disposeAll(); vi.useRealTimers(); }
});
