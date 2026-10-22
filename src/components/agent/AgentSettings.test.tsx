import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentSettings } from "./AgentSettings";

const harness = vi.hoisted(() => ({
  updateOptions: vi.fn(() => Promise.resolve()),
  setMode: vi.fn(() => Promise.resolve()),
  // A single stable reference, like the real service's getState(): useSyncExternalStore compares
  // snapshots by identity, and a fresh object literal on every call reads as a change every render.
  state: {
    mode: "ask",
    modelId: "local",
    overview: {
      hardware: { totalRamBytes: 16e9, availableRamBytes: 8e9, gpus: [], cpuThreads: 8, avx2: true },
      engineInstalled: true,
      runningModel: "local",
      modelsDir: "/private/models",
      freeDiskBytes: 50e9,
      recommended: "local",
      models: [
        {
          id: "local", name: "Lite", repo: "", path: "", sizeBytes: 1, contextTokens: 32768,
          totalParamsB: 4, license: { name: "", url: "" }, downloading: false,
          fit: { level: "gpu", neededBytes: 1, tokensPerSecond: 10 },
          local: { state: "ready", bytesOnDisk: 1 },
        },
      ],
    },
    downloads: {},
    installingEngine: false,
    cloud: null,
    cloudError: null,
    transcript: { busy: false },
  },
}));

vi.mock("../../services/agent", () => ({
  agent: {
    subscribe: () => () => undefined,
    options: () => ({
      effort: "medium",
      useGpu: true,
      searchEndpoint: "",
      visionEndpoint: "",
      imageEndpoint: "",
      contextTokens: 0,
      maxOutputTokens: 4096,
      reasoningBudgetTokens: 1024,
      maxSteps: 128,
      maxContinuations: 8,
      temperature: 0.6,
      commandTimeoutSeconds: 120,
      autoContinue: true,
      autoRunQueue: true,
      showReasoning: true,
      autoScroll: true,
    }),
    getState: () => harness.state,
    updateOptions: harness.updateOptions,
    setMode: harness.setMode,
    loadCloudStatus: () => Promise.resolve(),
    setCloudBaseUrl: () => Promise.resolve(""),
    setCloudKey: () => Promise.resolve(),
    clearCloudKey: () => Promise.resolve(),
    testCloudConnection: () => Promise.resolve([]),
    inferenceMode: () => "local" as const,
    toggleInference: () => Promise.resolve(),
  },
}));

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../services/container", () => ({
  container: { ipc: { openExternalUrl: vi.fn(() => Promise.resolve()) } },
}));
vi.mock("./AgentCapabilities", () => ({ AgentCapabilities: () => null }));

describe("automatic inference settings", () => {
  it("does not expose technical tuning controls for Local AI", () => {
    harness.state.modelId = "local";
    render(<AgentSettings />);
    expect(screen.queryByRole("tablist", { name: "agent.inference.title" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "agent.settings.apply" })).not.toBeInTheDocument();
  });

  it("does not expose manual context or token settings for Cloud AI", () => {
    harness.state.modelId = "openmindai-lite";
    render(<AgentSettings />);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "agent.settings.contextMode" })).not.toBeInTheDocument();
  });
});
