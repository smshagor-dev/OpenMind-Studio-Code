import { describe, expect, it, vi } from "vitest";

import type { AgentEvent, AgentIpc, AgentOverview, DownloadEvent, ModelView } from "./agentIpc";
import { AgentService, type AgentHost } from "./agentService";

function model(id: string, state: ModelView["local"]["state"], level: ModelView["fit"]["level"] = "cpu"): ModelView {
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
    license: { name: "NVIDIA Nemotron Open Model License", url: "https://example.com/license" },
    sizeBytes: 2_000_000_000,
    fit: { level, neededBytes: 3_000_000_000, tokensPerSecond: 8 },
    local: { state, bytesOnDisk: state === "ready" ? 2_000_000_000 : 0 },
    downloading: false,
  };
}

function overview(models: ModelView[], engineInstalled = true): AgentOverview {
  return {
    hardware: { totalRamBytes: 16 * 1024 ** 3, availableRamBytes: 8 * 1024 ** 3, gpus: [], cpuThreads: 8, avx2: true },
    models,
    recommended: models[0]?.id ?? null,
    engineInstalled,
    runningModel: null,
    modelsDir: "E:/OpenMind Studio/models",
    freeDiskBytes: 50 * 1024 ** 3,
  };
}

function setup(models: ModelView[], engineInstalled = true) {
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
    undo: vi.fn(() => Promise.resolve({ restored: ["main.py"], failed: [], canUndo: false })),
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
    await vi.waitFor(() => { expect(ipc.send).toHaveBeenCalled(); });
    expect(ipc.send).toHaveBeenCalledWith(expect.objectContaining({
      text: "fix the bug",
      modelId: "a",
      mode: "acceptEdits",
      unsaved: ["C:/p/dirty.ts"],
      uiLanguage: "Russian",
    }));
    const t = service.getState().transcript;
    expect(t.busy).toBe(true);
    expect(t.entries[0]).toMatchObject({ kind: "user", text: "fix the bug" });
    expect(t.startedAt).toBe(5000);
  });

  it("remembers the chosen model and mode", async () => {
    const { service, settings } = setup([model("a", "ready"), model("b", "ready")]);
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
    const { service, ipc, host, download } = setup([model("a", "notDownloaded")]);
    await service.start();
    await service.download("a");
    expect(host.confirm).toHaveBeenCalledWith(expect.stringContaining("agent.download.confirm"), "agent.download.accept");
    expect(ipc.download).toHaveBeenCalledWith("a");
    download({
      id: "a",
      state: "progress",
      progress: { phase: "downloading", file: 1, files: 1, doneBytes: 50, totalBytes: 100 },
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
    event({ type: "toolStart", id: "c1", name: "edit_file", kind: "edit", title: "Update", target: "x.ts" });
    event({ type: "permission", request: { id: "c1", kind: "edit", title: "Update", target: "x.ts", diff: null } });
    expect(service.getState().transcript.permission?.id).toBe("c1");
    await service.answer({ decision: "allowSession" });
    expect(ipc.answer).toHaveBeenCalledWith("c1", { decision: "allowSession" });
    expect(service.getState().transcript.permission).toBeNull();
  });

  it("shows a send failure in the conversation and frees the prompt", async () => {
    const { service, ipc } = setup([model("a", "ready")]);
    vi.mocked(ipc.send).mockRejectedValueOnce("The local AI engine (llama.cpp) is not installed yet.");
    await service.start();
    expect(await service.send("hi")).toBe(true);
    await vi.waitFor(() => { expect(service.getState().taskState?.tasks[0]?.status).toBe("failed"); });
    const t = service.getState().transcript;
    expect(t.busy).toBe(false);
    expect(t.entries[1]).toMatchObject({ kind: "notice", tone: "error" });
  });

  it("undo reports the files put back", async () => {
    const { service } = setup([model("a", "ready")]);
    await service.start();
    await service.undo();
    const t = service.getState().transcript;
    expect(t.entries.at(-1)).toMatchObject({ kind: "notice", text: "agent.undo.done" });
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
    vi.mocked(ipc.undo).mockResolvedValue({ restored: ["latest.py"], failed: [], canUndo: true });
    await service.undo();
    expect(service.getState().transcript.canUndo).toBe(true);
    vi.mocked(ipc.undo).mockResolvedValue({ restored: [], failed: ["later edits"], canUndo: true });
    await service.undo();
    expect(service.getState().transcript.canUndo).toBe(true);
  });

});

describe("Agent startup", () => {
  it("preloads an existing setup without downloading or starting a turn", async () => {
    const { service, ipc } = setup([model("a", "ready")]);
    await service.start();
    expect(ipc.startEngine).toHaveBeenCalledExactlyOnceWith("a");
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
    vi.mocked(ipc.startEngine).mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const startup = service.start();
    await vi.waitFor(() => { expect(ipc.startEngine).toHaveBeenCalledTimes(1); });
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
  await vi.waitFor(() => { expect(ipc.send).toHaveBeenCalledTimes(1); });
  const first = vi.mocked(ipc.send).mock.calls[0]?.[0].taskId;
  await service.send("Second goal");
  expect(ipc.send).toHaveBeenCalledTimes(1);
  event({ type: "turnEnd", taskId: first, reason: "done", message: null });
  await vi.waitFor(() => { expect(ipc.send).toHaveBeenCalledTimes(2); });
  const second = vi.mocked(ipc.send).mock.calls[1]?.[0].taskId;
  event({ type: "turnEnd", taskId: first, reason: "error", message: "late" });
  expect(service.getState().taskState?.activeId).toBe(second);
  expect(service.getState().transcript.busy).toBe(true);
  await service.stop();
  event({ type: "turnEnd", taskId: second, reason: "cancelled", message: null });
  expect(service.getState().taskState?.paused).toBe(true);
});
