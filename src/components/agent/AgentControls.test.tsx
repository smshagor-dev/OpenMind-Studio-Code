/* The agent methods are replaced by vi.fn in this module. */
/* eslint-disable @typescript-eslint/unbound-method */
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_AGENT_OPTIONS } from "../../services/agent/agentOptions";

vi.mock("../../services/agent", () => ({ agent: {
  send: vi.fn(() => Promise.resolve(true)), stop: vi.fn(() => Promise.resolve()),
  cycleMode: vi.fn(() => Promise.resolve()), suggestFiles: vi.fn(() => Promise.resolve([])),
  options: () => ({ ...DEFAULT_AGENT_OPTIONS }), getState: () => ({ mode: "ask", overview: null }),
  updateOptions: vi.fn(() => Promise.resolve()), setMode: vi.fn(() => Promise.resolve()),
} }));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
import { agent } from "../../services/agent";
import { AgentPrompt } from "./AgentPrompt";
import { AgentSettings } from "./AgentSettings";

beforeEach(() => { vi.clearAllMocks(); });
it("queues a prompt while the agent is busy and keeps Stop available", async () => {
  render(<AgentPrompt mode="ask" busy disabledReason={null} contextShare={null} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Then run tests" } });
  fireEvent.click(screen.getByRole("button", { name: "agent.tasks.queue" }));
  await waitFor(() => { expect(agent.send).toHaveBeenCalledWith("Then run tests"); });
  await waitFor(() => { expect(input).toHaveValue(""); });
  fireEvent.click(screen.getByRole("button", { name: "agent.tasks.stop" }));
  expect(agent.stop).toHaveBeenCalledOnce();
});
it("keeps a rejected queue submission in the composer", async () => {
  vi.mocked(agent.send).mockResolvedValueOnce(false);
  render(<AgentPrompt mode="ask" busy disabledReason={null} contextShare={null} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Keep this goal" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => { expect(agent.send).toHaveBeenCalled(); });
  expect(input).toHaveValue("Keep this goal");
});
it("applies permission and execution settings only on explicit Apply", async () => {
  render(<AgentSettings />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "auto" } });
  fireEvent.change(screen.getByLabelText("agent.settings.maxSteps"), { target: { value: "200" } });
  expect(agent.updateOptions).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "agent.settings.apply" }));
  await waitFor(() => { expect(agent.setMode).toHaveBeenCalledWith("auto"); });
  expect(agent.updateOptions).toHaveBeenCalledWith(expect.objectContaining({ maxSteps: 200 }));
});
