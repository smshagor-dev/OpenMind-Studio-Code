import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentState } from "../../services/agent/agentService";
import type { AgentOverview } from "../../services/agent/agentIpc";
import { EMPTY_TRANSCRIPT } from "../../services/agent/agentModel";

const harness = vi.hoisted(() => ({
  state: null as AgentState | null,
  listeners: new Set<() => void>(),
}));
function currentState(): AgentState {
  if (harness.state === null) throw new Error("Agent test state is missing");
  return harness.state;
}
vi.mock("../../services/agent", () => ({
  agent: {
    getState: () => currentState(),
    subscribe: (listener: () => void) => { harness.listeners.add(listener); return () => { harness.listeners.delete(listener); }; },
    start: vi.fn(() => Promise.resolve()),
    ready: () => Boolean(harness.state?.overview?.engineInstalled && harness.state.overview.models.some((m) => m.id === harness.state?.modelId && m.local.state === "ready")),
    openSettings: vi.fn(),
    openSetup: (showSetup: boolean) => {
      harness.state = { ...currentState(), showSetup };
      for (const listener of harness.listeners) listener();
    },
    download: vi.fn(() => Promise.resolve()),
    cancelDownload: vi.fn(() => Promise.resolve()),
    installEngine: vi.fn(() => Promise.resolve()),
    selectModel: vi.fn(() => Promise.resolve()),
    deleteModel: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    activate: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("../../services/container", () => ({
  container: {
    workspace: { subscribe: () => () => undefined, getActiveWorkspace: () => null },
    ipc: { openExternalUrl: vi.fn(() => Promise.resolve()) },
  },
}));
vi.mock("../../i18n", () => ({
  useT: () => (key: string) => ({
    "agent.ui.notConfigured": "Agent not Configured", "agent.ui.configureNow": "Configure now",
    "agent.ui.ready": "Agent is live", "agent.ui.configure": "Configure agent",
    "agent.ui.done": "Done", "agent.model.download": "Download",
    "agent.ui.acceptLicense": "I accept the", "agent.ui.license": "licence",
  } as Record<string, string>)[key] ?? key,
}));
vi.mock("./AgentTranscript", () => ({ AgentTranscript: () => null, AgentWelcome: () => <div>Welcome</div> }));
vi.mock("./AgentPrompt", () => ({ AgentPrompt: () => <div>Prompt</div> }));
vi.mock("./AgentPermission", () => ({ AgentPermission: () => null }));
vi.mock("./AgentSpinner", () => ({ AgentSpinner: () => null }));

import { agent } from "../../services/agent";
import { AgentView } from "./AgentView";
import { AgentSetupDialog } from "./AgentSetupDialog";

function overview(ready = false): AgentOverview {
  return {
    hardware: { totalRamBytes: 16e9, availableRamBytes: 8e9, gpus: [], cpuThreads: 8, avx2: true },
    engineInstalled: ready, runningModel: ready ? "internal" : null,
    modelsDir: "/private/models", freeDiskBytes: 50e9, recommended: "internal",
    models: [{
      id: "internal", family: "Nemotron", name: "Private model name", quant: "Q4_K_M",
      publisher: "Private publisher", description: "Private technical description",
      totalParamsB: 4, activeParamsB: 4, contextTokens: 32768, repo: "private/repo",
      license: { name: "Licence", url: "https://example.com/license" }, sizeBytes: 2e9,
      fit: { level: "cpu", neededBytes: 3e9, tokensPerSecond: 8 },
      local: { state: ready ? "ready" : "notDownloaded", bytesOnDisk: ready ? 2e9 : 0 }, downloading: false,
    }],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.listeners.clear();
  harness.state = {
    overview: overview(), overviewError: null, loadingOverview: false, installingEngine: false,
    downloads: {}, modelId: null, mode: "ask", transcript: EMPTY_TRANSCRIPT, showSetup: false, engineState: "idle",
  };
});
function mount() {
  return render(<div><AgentView /><AgentSetupDialog /></div>);
}
it("keeps setup out of the sidebar and opens it in a dialog on Configure now", () => {
  mount();
  expect(screen.getByText("Agent not Configured")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  screen.getByRole("button", { name: "Configure now" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Configure now" }));
  const dialog = screen.getByRole("dialog", { name: "OpenMindAI Agent" });
  expect(within(dialog).getByText("Lite")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/Private model|Private publisher|Q4_K_M|Nemotron|private\/models/);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Configure now" })).toHaveFocus();
});
it("requires licence consent before starting a setup download", () => {
  const downloadSpy = vi.spyOn(agent, "download");
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Configure now" }));
  const download = screen.getByRole("button", { name: "Download" });
  expect(download).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "I accept the" }));
  expect(download).toBeEnabled();
  fireEvent.click(download);
  expect(downloadSpy).toHaveBeenCalledWith("internal", true);
});
describe("configured header", () => {
  it("shows only the product, edition and live status", () => {
    harness.state = { ...currentState(), overview: overview(true), modelId: "internal", engineState: "ready" };
    mount();
    expect(screen.getByRole("status", { name: "Agent is live" })).toHaveClass("agent-live--ready");
    expect(screen.getByText("Lite")).toBeInTheDocument();
    expect(screen.queryByText("Agent not Configured")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Private model name");
  });
  it("does not show a green dot while the engine is loading", () => {
    harness.state = { ...currentState(), overview: overview(true), modelId: "internal", engineState: "loading" };
    const { container } = mount();
    expect(container.querySelector(".agent-live--ready")).toBeNull();
  });
});
