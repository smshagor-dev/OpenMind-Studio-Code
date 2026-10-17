import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentSettings } from "./AgentSettings";

const harness = vi.hoisted(() => ({
  updateOptions: vi.fn(() => Promise.resolve()),
  setMode: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../services/agent", () => ({
  agent: {
    options: () => ({
      effort: "medium",
      useGpu: true,
      searchEndpoint: "",
      visionEndpoint: "",
      imageEndpoint: "",
      contextTokens: 0,
      maxOutputTokens: 16384,
      maxSteps: 128,
      maxContinuations: 8,
      temperature: 0.6,
      commandTimeoutSeconds: 120,
      autoContinue: true,
      autoRunQueue: true,
      showReasoning: true,
      autoScroll: true,
    }),
    getState: () => ({
      mode: "ask",
      modelId: "local",
      overview: { models: [{ id: "local", contextTokens: 32768 }] },
    }),
    updateOptions: harness.updateOptions,
    setMode: harness.setMode,
  },
}));

vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("./AgentCapabilities", () => ({ AgentCapabilities: () => null }));

describe("context window settings", () => {
  it("defaults to automatic and hides manual token allocation", () => {
    render(<AgentSettings />);
    expect(screen.getByRole("combobox", { name: "agent.settings.contextMode" }))
      .toHaveValue("auto");
    expect(screen.queryByRole("spinbutton", { name: "agent.settings.contextTokens" }))
      .not.toBeInTheDocument();
  });

  it("can switch to manual context and back to automatic", async () => {
    render(<AgentSettings />);
    const selector = screen.getByRole("combobox", {
      name: "agent.settings.contextMode",
    });
    fireEvent.change(selector, { target: { value: "manual" } });
    const manual = screen.getByRole("spinbutton", {
      name: "agent.settings.contextTokens",
    });
    expect(manual).toHaveValue(16384);
    fireEvent.change(manual, { target: { value: "8192" } });
    fireEvent.click(screen.getByRole("button", { name: "agent.settings.apply" }));
    await waitFor(() =>
      expect(harness.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({ contextTokens: 8192 }),
      ),
    );
    fireEvent.change(selector, { target: { value: "auto" } });
    fireEvent.click(screen.getByRole("button", { name: "agent.settings.apply" }));
    await waitFor(() =>
      expect(harness.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({ contextTokens: 0 }),
      ),
    );
  });
});
