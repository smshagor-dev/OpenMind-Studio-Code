/* The agent methods are replaced by vi.fn in this module. */
/* eslint-disable @typescript-eslint/unbound-method */
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_AGENT_OPTIONS } from "../../services/agent/agentOptions";

const controlsState = vi.hoisted(
  (): {
    mode: string;
    overview: null;
    activeFile?: string | null;
    includeActiveFile?: boolean;
    cloud: null;
    cloudError: null;
  } => ({
    mode: "ask",
    overview: null,
    cloud: null,
    cloudError: null,
  }),
);

vi.mock("../../services/agent", () => ({
  agent: {
    subscribe: () => () => undefined,
    runCommand: vi.fn(() => Promise.resolve(true)),
    closeCommandPanel: vi.fn(),
    openSetup: vi.fn(),
    openSettings: vi.fn(),
    showHistory: vi.fn(),
    send: vi.fn(() => Promise.resolve(true)),
    stop: vi.fn(() => Promise.resolve()),
    continueTask: vi.fn(() => Promise.resolve(true)),
    pauseQueue: vi.fn(),
    resumeQueue: vi.fn(),
    cancelTask: vi.fn(),
    cycleMode: vi.fn(() => Promise.resolve()),
    toggleActiveFile: vi.fn(),
    attachFiles: vi.fn(() => Promise.resolve()),
    removeAttachment: vi.fn(),
    suggestFiles: vi.fn(() => Promise.resolve([])),
    options: () => ({ ...DEFAULT_AGENT_OPTIONS }),
    getState: () => controlsState,
    updateOptions: vi.fn(() => Promise.resolve()),
    setMode: vi.fn(() => Promise.resolve()),
    loadCloudStatus: vi.fn(() => Promise.resolve()),
    setCloudBaseUrl: vi.fn(() => Promise.resolve("")),
    setCloudKey: vi.fn(() => Promise.resolve()),
    clearCloudKey: vi.fn(() => Promise.resolve()),
    testCloudConnection: vi.fn(() => Promise.resolve([])),
    inferenceMode: vi.fn(() => "local" as const),
    toggleInference: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("../../i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../services/container", () => ({
  container: { ipc: { openExternalUrl: vi.fn(() => Promise.resolve()) } },
}));
import { agent } from "../../services/agent";
import { AgentPrompt } from "./AgentPrompt";
import { AgentQueue } from "./AgentQueue";
import type { TaskState } from "../../services/agent/agentTasks";
import { AgentSettings } from "./AgentSettings";

beforeEach(() => {
  vi.clearAllMocks();
  controlsState.activeFile = null;
  controlsState.includeActiveFile = undefined;
});

it("shows the editor's file as a chip that leaves it out of the message when clicked", () => {
  controlsState.activeFile = "src/stats.js";
  const view = render(
    <AgentPrompt
      mode="ask"
      busy={false}
      disabledReason={null}
      contextShare={null}
    />,
  );
  const chip = screen.getByRole("button", { name: "stats.js" });
  expect(chip).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(chip);
  expect(agent.toggleActiveFile).toHaveBeenCalledOnce();
  controlsState.includeActiveFile = false;
  view.rerender(
    <AgentPrompt
      mode="plan"
      busy={false}
      disabledReason={null}
      contextShare={null}
    />,
  );
  expect(screen.getByRole("button", { name: "stats.js" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

it("has no context row without a file or attachments, and one send button while idle", () => {
  const { container } = render(
    <AgentPrompt
      mode="ask"
      busy={false}
      disabledReason={null}
      contextShare={null}
    />,
  );
  expect(container.querySelector(".agent-composer__context")).toBeNull();
  expect(
    screen.getByRole("button", { name: "agent.tasks.send" }),
  ).toBeDisabled();
  expect(screen.queryByRole("button", { name: "agent.tasks.stop" })).toBeNull();
  expect(
    screen.getByRole("button", { name: /agent\.mode\.ask/ }),
  ).toBeInTheDocument();
});

it("while the agent works the send button becomes Stop until something is typed", () => {
  render(
    <AgentPrompt mode="ask" busy disabledReason={null} contextShare={null} />,
  );
  expect(
    screen.queryByRole("button", { name: "agent.tasks.queue" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "agent.tasks.stop" }),
  ).toBeEnabled();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "and then the docs" },
  });
  expect(
    screen.getByRole("button", { name: "agent.tasks.queue" }),
  ).toBeEnabled();
});
it("queues a prompt while the agent is busy and keeps Stop available", async () => {
  render(
    <AgentPrompt mode="ask" busy disabledReason={null} contextShare={null} />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Then run tests" } });
  fireEvent.click(screen.getByRole("button", { name: "agent.tasks.queue" }));
  await waitFor(() => {
    expect(agent.send).toHaveBeenCalledWith("Then run tests");
  });
  await waitFor(() => {
    expect(input).toHaveValue("");
  });
  fireEvent.click(screen.getByRole("button", { name: "agent.tasks.stop" }));
  expect(agent.stop).toHaveBeenCalledOnce();
});
it("keeps a rejected queue submission in the composer", async () => {
  vi.mocked(agent.send).mockResolvedValueOnce(false);
  render(
    <AgentPrompt mode="ask" busy disabledReason={null} contextShare={null} />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Keep this goal" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => {
    expect(agent.send).toHaveBeenCalled();
  });
  expect(input).toHaveValue("Keep this goal");
});
it("explains automatic local performance and keeps cloud setup separate", () => {
  render(<AgentSettings />);
  expect(
    screen.getByText(/Performance settings are automatic/),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("agent.settings.maxSteps")).toBeNull();
  expect(agent.updateOptions).not.toHaveBeenCalled();
});

it("shows the preparing goal and offers Continue even with later prompts pending", () => {
  const state: TaskState = {
    activeId: "first",
    paused: false,
    tasks: [
      {
        id: "first",
        text: "Preparing goal",
        mode: "ask",
        modelId: "a",
        workspace: null,
        options: { ...DEFAULT_AGENT_OPTIONS },
        status: "running",
        reason: null,
        createdAt: 1,
      },
    ],
  };
  const view = render(<AgentQueue state={state} />);
  // The running task is the transcript's last message; with nothing waiting there is no strip.
  expect(screen.queryByText("Preparing goal")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "agent.tasks.title" }),
  ).toBeNull();
  const first = state.tasks[0];
  if (!first) throw new Error("missing task");
  view.rerender(
    <AgentQueue
      state={{
        activeId: null,
        paused: true,
        tasks: [
          { ...first, status: "cancelled", reason: "cancelled" },
          { ...first, id: "next", text: "Later goal", status: "pending" },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "agent.tasks.continue" }));
  expect(agent.continueTask).toHaveBeenCalledOnce();
});

it("opens slash shortcuts, navigates them and runs the selected action", async () => {
  render(
    <AgentPrompt
      mode="ask"
      busy={false}
      disabledReason={null}
      contextShare={null}
    />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "/" } });
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(agent.runCommand).toHaveBeenCalledWith("/model");
  expect(agent.send).not.toHaveBeenCalled();
  await waitFor(() => expect(input).toHaveValue(""));
});

it("closes shortcuts with Escape without stopping the running task", () => {
  render(
    <AgentPrompt mode="ask" busy disabledReason={null} contextShare={null} />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "/" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(agent.stop).not.toHaveBeenCalled();
});

it("keeps a draft when opening shortcuts from the toolbar", () => {
  render(
    <AgentPrompt
      mode="ask"
      busy={false}
      disabledReason={null}
      contextShare={null}
    />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "My unfinished request" } });
  fireEvent.click(
    screen.getByRole("button", { name: "agent.composer.commands" }),
  );
  fireEvent.click(screen.getByRole("option", { name: /\/config/ }));
  expect(agent.runCommand).toHaveBeenCalledWith("/config");
  expect(input).toHaveValue("My unfinished request");
});

it("allows command arguments without a model while blocking ordinary prompts", async () => {
  render(
    <AgentPrompt
      mode="ask"
      busy={false}
      disabledReason="Install a model"
      contextShare={null}
    />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Normal prompt" } });
  expect(
    screen.getByRole("button", { name: "agent.tasks.send" }),
  ).toBeDisabled();
  fireEvent.change(input, { target: { value: "/help memory" } });
  expect(
    screen.getByRole("button", { name: "agent.tasks.send" }),
  ).toBeEnabled();
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => {
    expect(agent.send).toHaveBeenCalledWith("/help memory");
  });
});
