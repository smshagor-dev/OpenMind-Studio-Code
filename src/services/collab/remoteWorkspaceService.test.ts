import { describe, expect, it, vi } from "vitest";

import type {
  CollabNetIpc,
  ManifestEntry,
  NetEventPayload,
  RemoteEventPayload,
  RemoteFile,
  RemoteNotice,
  RemoteTreeView,
} from "./collabNetIpc";
import { RemoteWorkspaceService, type RemoteWorkspaceHost } from "./remoteWorkspaceService";

const ROOM = "0123456789abcdef0123456789abcdef";
const SRC = "a".repeat(32);
const MAIN = "b".repeat(32);
const LOGO = "c".repeat(32);

function entry(
  id: string,
  path: string,
  kind: "file" | "folder",
  parent: string | null,
  extra: Partial<ManifestEntry> = {},
): ManifestEntry {
  return {
    id,
    parent,
    name: path.split("/").pop() ?? path,
    path,
    kind,
    size: 12,
    modifiedMs: 100,
    binaryHint: false,
    ...extra,
  };
}

const TREE: RemoteTreeView = {
  ready: true,
  version: 1,
  root: "My Project",
  entries: [
    entry(SRC, "src", "folder", null),
    entry(MAIN, "src/main.ts", "file", SRC),
    entry(LOGO, "logo.png", "file", null),
  ],
};

function remoteFile(id: string, path: string, text: string | null): RemoteFile {
  return {
    roomUid: ROOM,
    fileId: id,
    path,
    name: path.split("/").pop() ?? path,
    size: text?.length ?? 4,
    sha256: "f".repeat(64),
    binary: text === null,
    text,
    encoding: text === null ? null : "utf-8",
  };
}

function setup() {
  let remoteListener: (p: RemoteEventPayload) => void = () => undefined;
  let netListener: (p: NetEventPayload) => void = () => undefined;
  const ipc: CollabNetIpc = {
    hostStart: vi.fn(),
    hostStop: vi.fn(),
    join: vi.fn(),
    rejoin: vi.fn(),
    leave: vi.fn(),
    status: vi.fn(),
    diagnostics: vi.fn(),
    remoteTree: vi.fn(() => Promise.resolve(TREE)),
    remoteOpen: vi.fn((_room: string, id: string) =>
      Promise.resolve(
        id === LOGO
          ? remoteFile(LOGO, "logo.png", null)
          : remoteFile(MAIN, "src/main.ts", "let x = 1;"),
      ),
    ),
    remoteCancel: vi.fn(() => Promise.resolve()),
    remoteRefresh: vi.fn(),
    onNet: vi.fn((l: (p: NetEventPayload) => void) => {
      netListener = l;
      return Promise.resolve(() => undefined);
    }),
    onRemote: vi.fn((l: (p: RemoteEventPayload) => void) => {
      remoteListener = l;
      return Promise.resolve(() => undefined);
    }),
  };
  const host = {
    openDocument: vi.fn<RemoteWorkspaceHost["openDocument"]>(),
    markDocument: vi.fn<RemoteWorkspaceHost["markDocument"]>(),
    languageOf: vi.fn((path: string) => (path.endsWith(".ts") ? "typescript" : "plaintext")),
    notice: vi.fn<RemoteWorkspaceHost["notice"]>(),
    error: vi.fn<RemoteWorkspaceHost["error"]>(),
  };
  const service = new RemoteWorkspaceService(ipc, host);
  const remote = async (event: RemoteNotice) => {
    remoteListener({ roomUid: ROOM, side: "participant", event });
    await vi.waitFor(() => undefined);
    await Promise.resolve();
  };
  const net = (state: "connected" | "disconnected") => {
    netListener({ roomUid: ROOM, side: "participant", event: { kind: "state", state } });
  };
  return { ipc, host, service, remote, net };
}

async function ready() {
  const s = setup();
  await s.service.start();
  await s.remote({ kind: "treeReady", version: 1 });
  await vi.waitFor(() => {
    expect(s.service.room(ROOM).tree.ready).toBe(true);
  });
  return s;
}

describe("RemoteWorkspaceService", () => {
  it("shows the tree when the backend has it, without downloading any file", async () => {
    const { service, ipc } = await ready();
    expect(service.rows(ROOM).map((r) => r.entry.path)).toEqual(["src", "logo.png"]);
    service.toggle(ROOM, SRC);
    expect(service.rows(ROOM).map((r) => r.entry.path)).toEqual(["src", "src/main.ts", "logo.png"]);
    service.toggle(ROOM, SRC);
    expect(service.rows(ROOM)).toHaveLength(2);
    service.toggle(ROOM, MAIN); // a file doesn't expand
    expect(service.room(ROOM).expanded.size).toBe(0);
    expect(ipc.remoteOpen).not.toHaveBeenCalled();
  });

  it("opens a text file as a read-only omcollab document that names no Owner path", async () => {
    const { service, host } = await ready();
    expect(await service.open(ROOM, MAIN)).toBe(true);
    const request = host.openDocument.mock.calls[0]?.[0];
    expect(request?.uri).toBe(`omcollab://${ROOM}/${MAIN}`);
    expect(request?.readonly).toBe(true);
    expect(request?.language).toBe("typescript");
    expect(request?.text).toBe("let x = 1;");
    expect(request?.collab).toMatchObject({
      roomUid: ROOM,
      fileId: MAIN,
      path: "src/main.ts",
      state: "current",
    });
    expect(JSON.stringify(request)).not.toMatch(/(^|[^A-Za-z])[A-Za-z]:[\\/]/); // no drive path
    expect(service.room(ROOM).loading.size).toBe(0);
    expect(await service.open(ROOM, SRC)).toBe(false); // a folder has nothing to open
  });

  it("reopening a file keeps its identity and a second click while it loads fetches nothing more", async () => {
    const { service, host, ipc } = await ready();
    const first = service.open(ROOM, MAIN);
    expect(await service.open(ROOM, MAIN)).toBe(false);
    await first;
    await service.open(ROOM, MAIN);
    expect(ipc.remoteOpen).toHaveBeenCalledTimes(2);
    const uris = host.openDocument.mock.calls.map((c) => c[0].uri);
    expect(new Set(uris).size).toBe(1);
  });

  it("never decodes a binary file into a document", async () => {
    const { service, host } = await ready();
    expect(await service.open(ROOM, LOGO)).toBe(false);
    expect(host.openDocument).not.toHaveBeenCalled();
    expect(host.notice).toHaveBeenCalledWith(expect.stringContaining("logo.png"));
  });

  it("reports a failed fetch and leaves nothing loading", async () => {
    const { service, host, ipc } = await ready();
    vi.mocked(ipc.remoteOpen).mockRejectedValueOnce("The file arrived damaged");
    expect(await service.open(ROOM, MAIN)).toBe(false);
    expect(host.error).toHaveBeenCalledWith(expect.stringContaining("damaged"));
    expect(service.room(ROOM).loading.size).toBe(0);
  });

  it("follows live tree changes: a rename keeps the open document, a content change makes it stale", async () => {
    const { service, host, remote } = await ready();
    await service.open(ROOM, MAIN);
    const uri = `omcollab://${ROOM}/${MAIN}`;
    await remote({
      kind: "treeDelta",
      base: 1,
      version: 2,
      upserts: [entry(SRC, "app", "folder", null), entry(MAIN, "app/main.ts", "file", SRC)],
      removed: [],
    });
    expect(service.room(ROOM).tree.entries.get(MAIN)?.path).toBe("app/main.ts");
    expect(host.markDocument).not.toHaveBeenCalled();
    await remote({
      kind: "treeDelta",
      base: 2,
      version: 3,
      upserts: [entry(MAIN, "app/main.ts", "file", SRC, { size: 99, modifiedMs: 200 })],
      removed: [],
    });
    expect(host.markDocument).toHaveBeenCalledWith(uri, "stale");
    expect(await service.refresh(uri)).toBe(true);
    const refreshed = host.openDocument.mock.lastCall?.[0];
    expect([refreshed?.uri, refreshed?.collab.state]).toEqual([uri, "current"]);
    await remote({ kind: "treeDelta", base: 3, version: 4, upserts: [], removed: [MAIN] });
    expect(host.markDocument).toHaveBeenLastCalledWith(uri, "unavailable");
  });

  it("asks for the whole tree again when a delta doesn't follow, and marks it stale on a reset", async () => {
    const { service, ipc, remote } = await ready();
    await remote({ kind: "treeDelta", base: 7, version: 8, upserts: [], removed: [] });
    expect(ipc.remoteTree).toHaveBeenCalledTimes(2);
    await remote({ kind: "treeStale" });
    expect(service.room(ROOM).tree.ready).toBe(false);
  });

  it("a disconnect makes open documents unavailable and a closed tab cancels its transfer", async () => {
    const { service, host, ipc, net } = await ready();
    await service.open(ROOM, MAIN);
    net("connected");
    expect(host.markDocument).not.toHaveBeenCalled();
    net("disconnected");
    expect(host.markDocument).toHaveBeenCalledWith(`omcollab://${ROOM}/${MAIN}`, "unavailable");
    expect(service.room(ROOM).connected).toBe(false);

    let finish: (file: RemoteFile) => void = () => undefined;
    vi.mocked(ipc.remoteOpen).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = service.open(ROOM, MAIN);
    service.documentClosed(`omcollab://${ROOM}/${MAIN}`);
    expect(ipc.remoteCancel).toHaveBeenCalledWith(ROOM, MAIN);
    finish(remoteFile(MAIN, "src/main.ts", "x"));
    await pending;
  });
});
