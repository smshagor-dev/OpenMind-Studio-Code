/* eslint-disable @typescript-eslint/unbound-method */
import { expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
vi.mock("../../services/agent", () => ({
  agent: {
    runCommand: vi.fn(() => Promise.resolve(true)),
    closeCommandPanel: vi.fn(),
  },
}));
import { agent } from "../../services/agent";
import { AgentCommandPanel } from "./AgentCommandPanel";
beforeEach(() => {
  vi.clearAllMocks();
});
it("edits memory, keeps its draft after a save failure, and closes with Escape", async () => {
  const panel = {
    title: "Project memory",
    body: "Original",
    kind: "memory" as const,
  };
  const view = render(<AgentCommandPanel panel={panel} />);
  const area = screen.getByRole("textbox", { name: "Project memory" });
  fireEvent.change(area, { target: { value: "Unsaved change" } });
  fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
  await waitFor(() => {
    expect(agent.runCommand).toHaveBeenCalledWith("/memory set Unsaved change");
  });
  view.rerender(
    <AgentCommandPanel
      panel={{ ...panel, error: "File has unsaved editor changes" }}
    />,
  );
  expect(area).toHaveValue("Unsaved change");
  expect(screen.getByRole("alert")).toHaveTextContent("unsaved editor");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(agent.closeCommandPanel).toHaveBeenCalledOnce();
});
it("traps keyboard focus and lets report commands run without adding a model message", async () => {
  render(
    <AgentCommandPanel
      panel={{ title: "MCP servers", body: "No servers", kind: "report" }}
    />,
  );
  const close = screen.getByRole("button", { name: "Close command panel" });
  const field = screen.getByRole("textbox", { name: "Command" });
  fireEvent.change(field, {
    target: { value: "/mcp add local http://localhost:3000/mcp" },
  });
  const run = screen.getByRole("button", { name: "Run" });
  run.focus();
  fireEvent.keyDown(run, { key: "Tab" });
  expect(close).toHaveFocus();
  fireEvent.click(run);
  await waitFor(() => {
    expect(agent.runCommand).toHaveBeenCalledWith(
      "/mcp add local http://localhost:3000/mcp",
    );
  });
  await waitFor(() => {
    expect(field).toHaveValue("");
  });
});
