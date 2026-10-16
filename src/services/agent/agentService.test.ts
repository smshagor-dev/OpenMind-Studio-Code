import { describe, expect, it, vi } from "vitest";

import type {
  AgentEvent,
  AgentIpc,
  AgentOverview,
  DownloadEvent,
  ModelView,
} from "./agentIpc";
import { AgentService, type AgentHost } from "./agentService";

function model(
  id: string,
  state: ModelView["local"]["state"],
  level: ModelView["fit"]["level"] = "cpu",
): ModelView {
  return {
    id,
    family: "Nemotron",
    name: `Nemotron ${id}`,
    quant: "Q4_K_M",
    publisher: "NVIDIA",
    description: "",
    totalParamsB: 4,
    activeParamsB: 4,
    contextTokens: 32768,
    repo: "nvidia/x",
    license: {
      name: "NVIDIA Nemotron Open Model License",
      url: "https://example.com/license",
    },
    sizeBytes: 2_000_000_000,
    fit: { level, neededBytes: 3_000_000_000, tokensPerSecond: 8 },
    local: { state, bytesOnDisk: state === "ready" ? 2_000_000_000 : 0 },
    downloading: false,
  };
}

function overview(models: ModelView[], engineInstalled = true): AgentOverview {
  return {
    hardware: {
      totalRamBytes: 16 * 1024 ** 3,
      availableRamBytes: 8 * 1024 ** 3,
      gpus: [],
      cpuThreads: 8,
      avx2: true,
    },
    models,
    recommended: models[0]?.id ?? null,
    engineInstalled,
    runningModel: null,
    modelsDir: "E:/OpenMind Studio/models",
    freeDiskBytes: 50 * 1024 ** 3,
  };
}

function setup(
  models: ModelView[],
  engineInstalled = true,
  historyIpc?: import("./agentHistory").HistoryIpc,
) {
  let onEvent: (event: AgentEvent) => void = () => undefined;
  let onDownload: (event: DownloadEvent) => void = () => undefined;
  const settings = new Map<string, string>();
  const ipc: AgentIpc = {
    overview: vi.fn(() => Promise.resolve(overview(models, engineInstalled))),
    download: vi.fn(() => Promise.resolve()),
    cancelDownload: vi.fn(() => Promise.resolve()),
    deleteModel: vi.fn(() => Promise.resolve()),
    send: vi.fn(() => Promise.resolve()),
    answer: vi.fn(() => Promise.resolve(true)),
    stop: vi.fn(() => Promise.resolve()),
    reset: vi.fn(() => Promise.resolve()),
    undo: vi.fn(() =>
      Promise.resolve({ restored: ["main.py"], failed: [], canUndo: false }),
    ),
    startEngine: vi.fn(() => Promise.resolve(true)),
    stopEngine: vi.fn(() => Promise.resolve()),
    onEvent: (listener) => {
      onEvent = listener;
      return Promise.resolve(() => undefined);
    },
    onDownload: (listener) => {
      onDownload = listener;
      return Promise.resolve(() => undefined);
    },
  };
  const host: AgentHost = {
    historyIpc,
    unsavedPaths: () => ["C:/p/dirty.ts"],
    uiLanguage: () => "Russian",
    hasFolder: () => true,
    installEngine: vi.fn(() => Promise.resolve(true)),
    confirm: vi.fn(() => Promise.resolve(true)),
    notify: vi.fn(),
    openFile: vi.fn(),
    suggestFiles: () => Promise.resolve([]),
    settingGet: (key) => Promise.resolve(settings.get(key) ?? null),
    settingSet: (key, value) => {
      settings.set(key, value);
      return Promise.resolve();
    },
    text: (key) => key,
  };
  const service = new AgentService(ipc, host, () => 5000);
  return {
    service,
    ipc,
    host,
    settings,
    event: (e: AgentEvent) => {
      onEvent(e);
    },
    download: (e: DownloadEvent) => {
      onDownload(e);
    },
  };
}

describe("AgentService", () => {
  it("is not ready until the engine is installed and a model is downloaded", async () => {
    const { service } = setup([model("a", "notDownloaded")], false);
    await service.start();
    expect(service.ready()).toBe(false);
    expect(service.sendBlocker()).toBe("agent.blocker.noModel");
  });

  it("picks the recommended downloaded model and sends with the mode, unsaved files and UI language", async () => {
    const { service, ipc } = setup([model("a", "ready"), model("b", "ready")]);
    await service.start();
    expect(service.getState().modelId).toBe("a");
    await service.setMode("acceptEdits");
    expect(await service.send("  fix the bug  ")).toBe(true);
    await vi.waitFor(() => {
      expect(ipc.send).toHaveBeenCalled();
    });
    expect(ipc.send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "fix the bug",
        modelId: "a",
        mode: "acceptEdits",
        unsaved: ["C:/p/dirty.ts"],
        uiLanguage: "Russian",
      }),
    );
    const t = service.getState().transcript;
    expect(t.busy).toBe(true);
    expect(t.entries[0]).toMatchObject({ kind: "user", text: "fix the bug" });
    expect(t.startedAt).toBe(5000);
  });

  it("remembers the chosen model and mode", async () => {
    const { service, settings } = setup([
      model("a", "ready"),
      model("b", "ready"),
    ]);
    await service.start();
    await service.selectModel("b");
    await service.cycleMode();
    expect(settings.get("agent.model")).toBe("b");
    expect(settings.get("agent.mode")).toBe("acceptEdits");
    const again = setup([model("a", "ready"), model("b", "ready")]);
    again.settings.set("agent.model", "b");
    again.settings.set("agent.mode", "plan");
    await again.service.start();
    expect(again.service.getState().modelId).toBe("b");
    expect(again.service.getState().mode).toBe("plan");
  });

  it("asks for the licence before a download and follows its progress", async () => {
    const { service, ipc, host, download } = setup([
      model("a", "notDownloaded"),
    ]);
    await service.start();
    await service.download("a");
    expect(host.confirm).toHaveBeenCalledWith(
      expect.stringContaining("agent.download.confirm"),
      "agent.download.accept",
    );
    expect(ipc.download).toHaveBeenCalledWith("a");
    download({
      id: "a",
      state: "progress",
      progress: {
        phase: "downloading",
        file: 1,
        files: 1,
        doneBytes: 50,
        totalBytes: 100,
      },
      message: null,
    });
    expect(service.getState().downloads.a?.progress?.doneBytes).toBe(50);
    download({ id: "a", state: "done", progress: null, message: null });
    expect(service.getState().downloads.a).toBeUndefined();
    expect(host.notify).toHaveBeenCalledWith("agent.download.done");
  });

  it("downloads nothing when the licence is declined", async () => {
    const { service, ipc, host } = setup([model("a", "notDownloaded")]);
    vi.mocked(host.confirm).mockResolvedValueOnce(false);
    await service.start();
    await service.download("a");
    expect(ipc.download).not.toHaveBeenCalled();
  });

  it("answers the permission question and clears it", async () => {
    const { service, ipc, event } = setup([model("a", "ready")]);
    await service.start();
    await service.send("go");
    event({
      type: "toolStart",
      id: "c1",
      name: "edit_file",
      kind: "edit",
      title: "Update",
      target: "x.ts",
    });
    event({
      type: "permission",
      request: {
        id: "c1",
        kind: "edit",
        title: "Update",
        target: "x.ts",
        diff: null,
      },
    });
    expect(service.getState().transcript.permission?.id).toBe("c1");
    await service.answer({ decision: "allowSession" });
    expect(ipc.answer).toHaveBeenCalledWith("c1", { decision: "allowSession" });
    expect(service.getState().transcript.permission).toBeNull();
  });

  it("shows a send failure in the conversation and frees the prompt", async () => {
    const { service, ipc } = setup([model("a", "ready")]);
    vi.mocked(ipc.send).mockRejectedValueOnce(
      "The local AI engine (llama.cpp) is not installed yet.",
    );
    await service.start();
    expect(await service.send("hi")).toBe(true);
    await vi.waitFor(() => {
      expect(service.getState().taskState?.tasks[0]?.status).toBe("failed");
    });
    const t = service.getState().transcript;
    expect(t.busy).toBe(false);
    expect(t.entries[1]).toMatchObject({ kind: "notice", tone: "error" });
  });

  it("undo reports the files put back", async () => {
    const { service } = setup([model("a", "ready")]);
    await service.start();
    await service.undo();
    const t = service.getState().transcript;
    expect(t.entries.at(-1)).toMatchObject({
      kind: "notice",
      text: "agent.undo.done",
    });
    expect(t.canUndo).toBe(false);
  });

  it("a new chat stops a running turn first", async () => {
    const { service, ipc } = setup([model("a", "ready")]);
    await service.start();
    await service.send("go");
    await service.newChat();
    expect(ipc.stop).toHaveBeenCalled();
    expect(ipc.reset).toHaveBeenCalled();
    expect(service.getState().transcript.entries).toEqual([]);
  });
  it("keeps Undo available when the backend has earlier or conflicted history", async () => {
    const { service, ipc } = setup([model("a", "ready")]);
    await service.start();
    vi.mocked(ipc.undo).mockResolvedValue({
      restored: ["latest.py"],
      failed: [],
      canUndo: true,
    });
    await service.undo();
    expect(service.getState().transcript.canUndo).toBe(true);
    vi.mocked(ipc.undo).mockResolvedValue({
      restored: [],
      failed: ["later edits"],
      canUndo: true,
    });
    await service.undo();
    expect(service.getState().transcript.canUndo).toBe(true);
  });
});

describe("Agent startup", () => {
  it("preloads an existing setup without downloading or starting a turn", async () => {
    const { service, ipc } = setup([model("a", "ready")]);
    await service.start();
    expect(ipc.startEngine).toHaveBeenCalledExactlyOnceWith("a", true);
    expect(ipc.download).not.toHaveBeenCalled();
    expect(ipc.send).not.toHaveBeenCalled();
    expect(service.getState().engineState).toBe("ready");
  });

  it("leaves an unconfigured editor alone", async () => {
    const { service, ipc } = setup([model("a", "notDownloaded")]);
    await service.start();
    expect(ipc.startEngine).not.toHaveBeenCalled();
    expect(ipc.download).not.toHaveBeenCalled();
    expect(service.getState().showSetup).toBe(false);
  });

  it("does not mark a failed startup as live and allows retry", async () => {
    const { service, ipc } = setup([model("a", "ready")]);
    vi.mocked(ipc.startEngine).mockRejectedValueOnce(new Error("failed"));
    await service.start();
    expect(service.getState().engineState).toBe("failed");
    expect(service.getState().transcript.entries).toEqual([]);
    await service.activate();
    expect(service.getState().engineState).toBe("ready");
  });

  it("does not mark another window's different agent as live", async () => {
    const { service, event } = setup([model("a", "ready")]);
    await service.start();
    event({ type: "engine", state: "ready", model: "b", message: null });
    expect(service.getState().engineState).toBe("idle");
  });

  it("deduplicates startup while an engine is still loading", async () => {
    const { service, ipc } = setup([model("a", "ready")]);
    let finish!: (ready: boolean) => void;
    vi.mocked(ipc.startEngine).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const startup = service.start();
    await vi.waitFor(() => {
      expect(ipc.startEngine).toHaveBeenCalledTimes(1);
    });
    const activation = service.activate();
    await service.selectModel("b");
    expect(service.getState().modelId).toBe("a");
    finish(true);
    await Promise.all([startup, activation]);
    expect(ipc.startEngine).toHaveBeenCalledTimes(1);
  });
});

it("reports a runtime install failure inside agent setup", async () => {
  const { service, host } = setup([model("a", "notDownloaded")], false);
  vi.mocked(host.installEngine).mockResolvedValueOnce(false);
  await service.start();
  await service.installEngine();
  expect(service.getState().setupError).toBe("agent.ui.operationFailed");
  expect(service.getState().installingEngine).toBe(false);
});

it("queues follow-up prompts and ignores stale task completion events", async () => {
  const { service, ipc, event } = setup([model("a", "ready")]);
  await service.start();
  await service.send("First goal");
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalledTimes(1);
  });
  const first = vi.mocked(ipc.send).mock.calls[0]?.[0].taskId;
  await service.send("Second goal");
  expect(ipc.send).toHaveBeenCalledTimes(1);
  event({ type: "turnEnd", taskId: first, reason: "done", message: null });
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalledTimes(2);
  });
  const second = vi.mocked(ipc.send).mock.calls[1]?.[0].taskId;
  event({ type: "turnEnd", taskId: first, reason: "error", message: "late" });
  expect(service.getState().taskState?.activeId).toBe(second);
  expect(service.getState().transcript.busy).toBe(true);
  await service.stop();
  event({
    type: "turnEnd",
    taskId: second,
    reason: "cancelled",
    message: null,
  });
  expect(service.getState().taskState?.paused).toBe(true);
});

it("reports Stop failure and keeps later tasks paused", async () => {
  const { service, ipc, host } = setup([model("a", "ready")]);
  await service.start();
  await service.send("Goal");
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalledOnce();
  });
  await service.send("Later");
  vi.mocked(ipc.stop).mockRejectedValueOnce("Stop transport failed");
  await service.stop();
  expect(host.notify).toHaveBeenCalledWith("Stop transport failed");
  expect(service.getState().taskState?.paused).toBe(true);
  expect(ipc.send).toHaveBeenCalledOnce();
});

it("continues the interrupted goal before pending work and ignores removed prompts", async () => {
  const { service, ipc, event } = setup([model("a", "ready")]);
  await service.start();
  await service.send("Original goal");
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalledOnce();
  });
  const id = vi.mocked(ipc.send).mock.calls[0]?.[0].taskId;
  await service.send("Next goal");
  await service.stop();
  event({ type: "turnEnd", taskId: id, reason: "cancelled", message: null });
  await service.send("Removed goal");
  const removed = service.getState().taskState?.tasks.at(-1);
  if (!removed) throw new Error("missing queued task");
  service.cancelTask(removed.id);
  expect(await service.continueTask()).toBe(true);
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalledTimes(2);
  });
  expect(vi.mocked(ipc.send).mock.calls[1]?.[0].text).toContain(
    "Original goal",
  );
  expect(vi.mocked(ipc.send).mock.calls[1]?.[0].text).not.toContain(
    "Removed goal",
  );
});

it("refuses to continue an interrupted goal in a different project", async () => {
  const { service, ipc, host, event } = setup([model("a", "ready")]);
  host.workspacePath = () => "/one";
  await service.start();
  await service.send("Change this project");
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalledOnce();
  });
  const id = vi.mocked(ipc.send).mock.calls[0]?.[0].taskId;
  expect(vi.mocked(ipc.send).mock.calls[0]?.[0].workspace).toBe("/one");
  await service.stop();
  event({ type: "turnEnd", taskId: id, reason: "cancelled", message: null });
  host.workspacePath = () => "/two";
  expect(await service.continueTask()).toBe(false);
  expect(ipc.send).toHaveBeenCalledOnce();
  expect(host.notify).toHaveBeenCalledWith("agent.tasks.workspaceChanged");
});

describe("persisted agent conversations", () => {
  it("refuses another workspace before resetting the active conversation", async () => {
    const history = {
      list: vi.fn(() => Promise.resolve([])),
      save: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve(true)),
      load: vi.fn(() =>
        Promise.resolve({
          id: "old",
          title: "old",
          providerId: "/another-project",
          model: "agent-v1",
          createdAt: 1,
          updatedAt: 1,
          messages: [],
        }),
      ),
    };
    const { service, ipc, host } = setup([model("a", "ready")], true, history);
    await service.start();
    await service.restoreHistory("old");
    expect(ipc.reset).not.toHaveBeenCalled();
    expect(host.notify).toHaveBeenCalledWith(
      expect.stringContaining("agent.tasks.workspaceChanged"),
    );
  });
  it("restores context without sending until the user submits a new request", async () => {
    const history = {
      list: vi.fn(() => Promise.resolve([])),
      save: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve(true)),
      load: vi.fn(() =>
        Promise.resolve({
          id: "old",
          title: "old",
          providerId: "",
          model: "agent-v1",
          createdAt: 1,
          updatedAt: 1,
          messages: [
            {
              role: "entry",
              content: JSON.stringify({
                kind: "user",
                id: "prior",
                text: "Remember the project goal",
              }),
              createdAt: 1,
              error: null,
            },
          ],
        }),
      ),
    };
    const { service, ipc } = setup([model("a", "ready")], true, history);
    await service.start();
    await service.restoreHistory("old");
    expect(ipc.send).not.toHaveBeenCalled();
    expect(await service.send("continue")).toBe(true);
    await vi.waitFor(() => {
      expect(ipc.send).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "old",
          history: [{ role: "user", content: "Remember the project goal" }],
        }),
      );
    });
    await service.newChat();
  });
});

it("keeps attachment context on Continue with unique transcript entry IDs", async () => {
  const { service, ipc, event } = setup([model("a", "ready")]);
  await service.start();
  const file = new File(["const answer = 42;"], "code.ts", {
    type: "text/plain",
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: () =>
      Promise.resolve(new TextEncoder().encode("const answer = 42;").buffer),
  });
  await service.attachFiles([file]);
  await service.send("read this file");
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalledTimes(1);
  });
  event({ type: "turnEnd", reason: "cancelled", message: null });
  expect(await service.continueTask()).toBe(true);
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalledTimes(2);
  });
  const documents = service
    .getState()
    .transcript.entries.filter((entry) => entry.kind === "document");
  expect(documents).toHaveLength(2);
  expect(new Set(documents.map((entry) => entry.id)).size).toBe(2);
  expect(ipc.send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      attachments: [
        expect.objectContaining({
          name: "code.ts",
          text: "const answer = 42;",
        }),
      ],
    }),
  );
});

it("opens Documents before queuing a chat when no folder is selected", async () => {
  const { service, host, ipc } = setup([model("a", "ready")]);
  let path: string | null = null;
  host.hasFolder = () => path !== null;
  host.workspacePath = () => path;
  host.ensureWorkspace = vi.fn(() => {
    path = "C:/Users/Student/Documents";
    return Promise.resolve(true);
  });
  await service.start();
  expect(service.sendBlocker()).toBeNull();
  expect(await service.send("Create a Python file")).toBe(true);
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalled();
  });
  expect(host.ensureWorkspace).toHaveBeenCalledOnce();
  expect(ipc.send).toHaveBeenCalledWith(
    expect.objectContaining({ workspace: "C:/Users/Student/Documents" }),
  );
  service.dispose();
});

it("keeps the chat draft when Documents cannot be opened", async () => {
  const { service, host, ipc } = setup([model("a", "ready")]);
  host.hasFolder = () => false;
  host.ensureWorkspace = vi.fn(() => Promise.resolve(false));
  await service.start();
  expect(await service.send("Keep this request")).toBe(false);
  expect(ipc.send).not.toHaveBeenCalled();
  service.dispose();
});

describe("slash command workflows", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  it("runs help and settings without a model; rejects unknown commands without inference", async () => {
    const { service, ipc } = setup([], false);
    await service.start();
    expect(await service.send("/help")).toBe(true);
    expect(service.getState().commandPanel?.body).toContain("/fork");
    expect(await service.send("/config")).toBe(true);
    expect(service.getState().showSettings).toBe(true);
    expect(await service.send("/missing")).toBe(false);
    expect(ipc.send).not.toHaveBeenCalled();
  });
  it("validates settings and aliases, changes real budgets and policies", async () => {
    const { service } = setup([model("a", "ready")]);
    await service.start();
    expect(await service.send("/effect low")).toBe(true);
    expect(service.options()).toMatchObject({
      effort: "low",
      maxSteps: 32,
      maxOutputTokens: 2048,
    });
    expect(await service.send("/permission plan")).toBe(true);
    expect(service.getState().mode).toBe("plan");
    expect(await service.send("/config maxSteps 9000")).toBe(false);
    expect(service.options().maxSteps).toBe(32);
    expect(await service.send("/config autoContinue false")).toBe(true);
    expect(service.options().autoContinue).toBe(false);
    expect(await service.send("/model missing")).toBe(false);
  });
  it("uses native context, memory and init actions with explicit save confirmation", async () => {
    const { service, ipc, host } = setup([]);
    ipc.control = vi.fn((action) =>
      Promise.resolve(
        action === "memory_read"
          ? "Remember tests"
          : action === "init"
            ? "C:/p/OPENMIND.md"
            : { messages: 3 },
      ),
    );
    await service.start();
    expect(await service.send("/context")).toBe(true);
    expect(ipc.control).toHaveBeenCalledWith("context", "");
    expect(await service.send("/compact")).toBe(true);
    expect(ipc.control).toHaveBeenCalledWith("compact", "");
    expect(await service.send("/memory")).toBe(true);
    expect(service.getState().commandPanel?.kind).toBe("memory");
    vi.mocked(host.confirm).mockResolvedValueOnce(false);
    expect(await service.send("/memory set changed")).toBe(false);
    expect(ipc.control).not.toHaveBeenCalledWith("memory_write", "changed");
    expect(await service.send("/memory set first\nsecond")).toBe(true);
    expect(ipc.control).toHaveBeenCalledWith("memory_write", "first\nsecond");
    expect(await service.send("/init")).toBe(true);
    expect(host.openFile).toHaveBeenCalledWith("C:/p/OPENMIND.md");
  });
  it("bridges plugins, diagnostics, export, and read-only Git review", async () => {
    const { service, ipc, host } = setup([model("a", "ready")]);
    ipc.control = vi.fn(() => Promise.resolve({ workspace: "C:/p" }));
    host.plugins = vi.fn(() => Promise.resolve("test.extension enabled"));
    host.gitChanges = vi.fn(() =>
      Promise.resolve("main.ts BEFORE: x AFTER: y"),
    );
    host.exportChat = vi.fn(() => Promise.resolve("C:/chat.md"));
    await service.start();
    expect(await service.send("/pluging list")).toBe(true);
    expect(host.plugins).toHaveBeenCalledWith("list");
    expect(await service.send("/doctor")).toBe(true);
    expect(service.getState().commandPanel?.body).toContain("selectedModel");
    expect(await service.send("/export")).toBe(true);
    expect(host.exportChat).toHaveBeenCalledWith(
      expect.stringContaining("OpenMindAI"),
    );
    expect(await service.send("/diff")).toBe(true);
    expect(service.getState().commandPanel?.body).toContain("main.ts");
    expect(await service.send("/review focus on regressions")).toBe(true);
    await tick();
    const reviewRequest = vi.mocked(ipc.send).mock.calls.at(-1)?.[0];
    expect(reviewRequest?.mode).toBe("plan");
    expect(reviewRequest?.text).toContain("focus on regressions");
    expect(service.getState().mode).toBe("ask");
    expect(await service.send("/task cancel nonexistent")).toBe(false);
    await service.stop();
  });
  it("persists approved MCP configuration and reconnects tools before inference", async () => {
    const { service, ipc, settings, host } = setup([model("a", "ready")]);
    ipc.control = vi.fn(() => Promise.resolve([{ name: "local", tools: [] }]));
    await service.start();
    vi.mocked(host.confirm).mockResolvedValueOnce(false);
    expect(await service.send("/mcp add local http://localhost:3000/mcp")).toBe(
      false,
    );
    expect(settings.has("agent.mcp.servers")).toBe(false);
    expect(await service.send("/mcp add local http://localhost:3000/mcp")).toBe(
      true,
    );
    expect(JSON.parse(settings.get("agent.mcp.servers") ?? "[]")).toHaveLength(
      1,
    );
    expect(await service.send("/mcp tools")).toBe(true);
    expect(await service.send("/mcp remove local")).toBe(true);
    expect(JSON.parse(settings.get("agent.mcp.servers") ?? "[]")).toHaveLength(
      0,
    );
  });
  it("forks persisted transcript and resumes the original without retaining undo", async () => {
    const stored = new Map<
      string,
      Parameters<import("./agentHistory").HistoryIpc["save"]>[0]
    >();
    const history: import("./agentHistory").HistoryIpc = {
      list: () => Promise.resolve([]),
      load: (id) => Promise.resolve(stored.get(id) ?? null),
      save: (v) => {
        stored.set(v.id, structuredClone(v));
        return Promise.resolve();
      },
      delete: (id) => Promise.resolve(stored.delete(id)),
    };
    const { service, event, ipc } = setup([model("a", "ready")], true, history);
    await service.start();
    await service.send("Original question");
    await tick();
    event({ type: "text", text: "Original answer" });
    event({ type: "turnEnd", reason: "done", message: null });
    await tick();
    const original: string | undefined = service.getState().conversationId;
    expect(await service.send("/fork")).toBe(true);
    const fork: string | undefined = service.getState().conversationId;
    expect(fork).not.toBe(original);
    expect(stored.has(original ?? "")).toBe(true);
    expect(stored.has(fork ?? "")).toBe(true);
    expect(service.getState().transcript.canUndo).toBe(false);
    expect(await service.send(`/resume ${original}`)).toBe(true);
    expect(service.getState().conversationId).toBe(original);
    expect(
      service
        .getState()
        .transcript.entries.some(
          (e) => e.kind === "assistant" && e.text === "Original answer",
        ),
    ).toBe(true);
    expect(ipc.reset).toHaveBeenCalled();
    expect(await service.send("/resume nonexistent")).toBe(false);
  });
  it("continues a goal, stops immediately, and completes only after the completion marker", async () => {
    const { service, event, ipc } = setup([model("a", "ready")]);
    await service.start();
    expect(await service.send("/goal Implement and test feature")).toBe(true);
    await tick();
    expect(vi.mocked(ipc.send).mock.calls.at(-1)?.[0].text).toContain(
      "[OPENMIND_GOAL_COMPLETE]",
    );
    event({ type: "text", text: "Need another pass" });
    event({ type: "turnEnd", reason: "done", message: null });
    await tick();
    await tick();
    expect(ipc.send).toHaveBeenCalledTimes(2);
    await service.send("/stop");
    expect(service.getState().goal?.state).toBe("paused");
    expect(ipc.stop).toHaveBeenCalled();
    event({ type: "turnEnd", reason: "cancelled", message: null });
    await tick();
    expect(await service.send("/goal resume")).toBe(true);
    await tick();
    event({ type: "text", text: "Verified. [OPENMIND_GOAL_COMPLETE]" });
    event({ type: "turnEnd", reason: "done", message: null });
    await tick();
    expect(service.getState().goal?.state).toBe("completed");
    expect(ipc.send).toHaveBeenCalledTimes(3);
  });
});

it("reports asynchronous command failures and preserves unsaved memory", async () => {
  const { service, ipc } = setup([]);
  ipc.control = vi.fn(() => Promise.resolve("Original"));
  await service.start();
  await service.send("/memory");
  ipc.control = vi.fn(() =>
    Promise.reject(new Error("Unsaved editor changes")),
  );
  expect(await service.send("/memory set Draft")).toBe(false);
  expect(service.getState().commandPanel).toMatchObject({
    kind: "memory",
    body: "Original",
  });
  expect(service.getState().commandPanel?.error).toContain(
    "Unsaved editor changes",
  );
});
it("does not enqueue a goal after Stop while its saved state is still writing", async () => {
  const { service, ipc, host } = setup([model("a", "ready")]);
  await service.start();
  const save = host.settingSet;
  let release: () => void = () => undefined;
  host.settingSet = (key, value) =>
    key.startsWith("agent.goal.") && value.includes('"active"')
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : save(key, value);
  const starting = service.send("/goal Ship safely");
  await Promise.resolve();
  await service.stop();
  release();
  expect(await starting).toBe(false);
  expect(ipc.send).not.toHaveBeenCalled();
  expect(service.getState().goal?.state).toBe("paused");
});
it("pauses a goal after a failed native dispatch", async () => {
  const { service, ipc } = setup([model("a", "ready")]);
  await service.start();
  vi.mocked(ipc.send).mockRejectedValueOnce(new Error("Engine unavailable"));
  await service.send("/goal Test failure handling");
  await vi.waitFor(() => {
    expect(service.getState().goal?.state).toBe("paused");
  });
});

it("keeps the original conversation when history storage prevents a fork", async () => {
  const history: import("./agentHistory").HistoryIpc = {
    list: () => Promise.resolve([]),
    load: () => Promise.resolve(null),
    save: () => Promise.reject(new Error("Disk full")),
    delete: () => Promise.resolve(false),
  };
  const { service, ipc, event } = setup([model("a", "ready")], true, history);
  await service.start();
  await service.send("Preserve this");
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalled();
  });
  event({ type: "turnEnd", reason: "done", message: null });
  const original = service.getState().conversationId;
  expect(await service.send("/fork")).toBe(false);
  expect(service.getState().conversationId).toBe(original);
  expect(ipc.reset).not.toHaveBeenCalled();
  expect(service.getState().commandPanel?.body).toContain(
    "history could not be saved",
  );
});
it("keeps chat available when an optional MCP server is offline and avoids repeated automatic retries", async () => {
  const { service, ipc, settings, event } = setup([model("a", "ready")]);
  settings.set(
    "agent.mcp.servers",
    JSON.stringify([{ name: "offline", url: "http://localhost:3000/mcp" }]),
  );
  ipc.control = vi.fn(() => Promise.reject(new Error("Connection refused")));
  await service.start();
  await service.send("First request");
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalledTimes(1);
  });
  event({ type: "turnEnd", reason: "done", message: null });
  await service.send("Second request");
  await vi.waitFor(() => {
    expect(ipc.send).toHaveBeenCalledTimes(2);
  });
  expect(ipc.control).toHaveBeenCalledTimes(1);
  await service.stop();
});
it("bounds a goal to eight turns even when ordinary queue autorun is disabled", async () => {
  const { service, ipc, event } = setup([model("a", "ready")]);
  await service.start();
  await service.updateOptions({ autoRunQueue: false });
  await service.send("/goal Finish within the cap");
  for (let n = 1; n <= 8; n++) {
    await vi.waitFor(() => {
      expect(ipc.send).toHaveBeenCalledTimes(n);
    });
    event({ type: "text", text: "More work remains" });
    event({ type: "turnEnd", reason: "done", message: null });
  }
  await vi.waitFor(() => {
    expect(service.getState().goal?.state).toBe("paused");
  });
  expect(ipc.send).toHaveBeenCalledTimes(8);
});

it("does not save a memory editor draft into another workspace", async () => {
  const { service, ipc, host } = setup([]);
  let workspace = "C:/first";
  host.workspacePath = () => workspace;
  ipc.control = vi.fn(() => Promise.resolve("First project notes"));
  await service.start();
  await service.send("/memory");
  workspace = "C:/second";
  expect(await service.send("/memory set Changed notes")).toBe(false);
  expect(ipc.control).not.toHaveBeenCalledWith("memory_write", "Changed notes");
  expect(service.getState().commandPanel?.error).toContain("workspace changed");
});
