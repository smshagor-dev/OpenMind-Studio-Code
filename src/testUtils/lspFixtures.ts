import { vi } from "vitest";

import { BufferManager } from "../services/bufferManager";
import { DocumentService } from "../services/documentService";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type {
  LspCapabilities,
  LspDiagnosticsEvent,
  LspLogEvent,
  LspServerInfo,
  LspSnapshot,
  LspSyncOutcome,
} from "../services/ipc";
import { LspService } from "../services/lspService";
import { ipcFeed } from "./canonicalFeeds";
import { createFakeIpc, type FakeIpc } from "./fakeIpcClient";

/** Shared by the language-server tests: a Pyright-like server and an LspService connected to a fake backend. */
export const PY = "C:/My Site/app.py";
export const TXT = "C:/My Site/notes.txt";

export const ALL: LspCapabilities = {
  hover: true,
  completion: true,
  completionResolve: false,
  completionTriggers: [],
  signatureHelp: true,
  signatureTriggers: [],
  definition: true,
  declaration: false,
  typeDefinition: false,
  implementation: false,
  references: true,
  rename: true,
  prepareRename: false,
  formatting: false,
  rangeFormatting: false,
  documentSymbol: true,
};

export function server(patch: Partial<LspServerInfo> = {}): LspServerInfo {
  return {
    id: "python",
    name: "Pyright",
    languages: ["python"],
    note: null,
    contents: "pyright 1.1.414",
    installed: true,
    runtime: "node",
    bundled: false,
    installSource: null,
    state: "running",
    workspace: "C:/My Site",
    node: "OpenMind portable Node.js",
    capabilities: ALL,
    openDocuments: 1,
    pid: 4242,
    canInstall: true,
    installBlocked: null,
    logPath: "C:/app/logs/lsp/python.log",
    logExists: true,
    ...patch,
  };
}

export function snapshot(servers: LspServerInfo[]): LspSnapshot {
  return {
    workspace: "C:/My Site",
    node: "OpenMind portable Node.js",
    nodeProblem: null,
    bundle: { present: false, problem: null, nodeVersion: null, packs: 0 },
    verbose: false,
    servers,
  };
}

export interface Rig {
  ipc: FakeIpc;
  events: EventBus<AppEvents>;
  documents: DocumentService;
  buffers: BufferManager;
  lsp: LspService;
  log: string[];
  status: { current: LspSnapshot };
  handlers: {
    log?: (event: LspLogEvent) => void;
    diagnostics?: (event: LspDiagnosticsEvent) => void;
  };
  outcome: { current: LspSyncOutcome };
  active: { current: string | null };
  enabled: { current: boolean };
}

export async function rig(servers: LspServerInfo[] = [server()]): Promise<Rig> {
  const enabled = { current: true };
  const status = { current: snapshot(servers) };
  const handlers: Rig["handlers"] = {};
  const outcome = { current: { state: "ready", server: "python" } as LspSyncOutcome };
  const ipc = createFakeIpc({
    lspStatus: vi.fn().mockImplementation(() => Promise.resolve(status.current)),
    lspSyncDocument: vi.fn().mockImplementation(() => Promise.resolve(outcome.current)),
    documentOpen: vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve({ path, content: "x = 1\n", encoding: "utf8", lineEnding: "lf" }),
      ),
    documentRead: vi.fn().mockResolvedValue({ state: "missing" }),
    onLspLog: vi.fn().mockImplementation((handler: (event: LspLogEvent) => void) => {
      handlers.log = handler;
      return Promise.resolve(() => undefined);
    }),
    onLspDiagnostics: vi
      .fn()
      .mockImplementation((handler: (event: LspDiagnosticsEvent) => void) => {
        handlers.diagnostics = handler;
        return Promise.resolve(() => undefined);
      }),
  });
  const events = new EventBus<AppEvents>();
  const buffers = new BufferManager();
  const documents = new DocumentService(ipc, buffers, events);
  const log: string[] = [];
  const active = { current: null as string | null };
  const lsp = new LspService(ipc, events, documents, {
    log: (line) => log.push(line),
    activeDocId: () => active.current,
    enabled: () => enabled.current,
  });
  // The canonical language-server state, as the backend delivers it (read from `status` when it changes).
  const feed = ipcFeed(() => ipc.lspStatus());
  lsp.useCanonical(feed);
  await feed.catchUp();
  await lsp.initialize();
  return { ipc, events, documents, buffers, lsp, log, status, handlers, outcome, active, enabled };
}
