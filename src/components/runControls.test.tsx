import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import type { RunButtonView, RunState } from "../services/runCodeService";
import { RunConfigurationService } from "../services/runConfigurationService";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));
vi.mock("../services/editorHeaderMenu", () => ({ buildEditorActionsMenu: () => [] }));

import { EditorHeaderActions } from "./EditorHeaderActions";
import { RunCodeButton, RunCodeDropdown, RunStatusIndicator } from "./RunCodeControls";
import { RunConfigurationDialog } from "./RunConfigurationDialog";

const READY: RunButtonView = {
  state: "ready",
  enabled: true,
  tooltip: 'Run Code (Ctrl+F5) — python "C:/p/hello.py"',
  canStop: false,
};

interface Setup {
  view: RunButtonView;
  running?: boolean;
  path?: string | null;
  lastRun?: RunState["lastRun"];
  previewable?: boolean;
  configurable?: boolean;
}

const WORKSPACE_STATE = {};

function setup(options: Setup) {
  const run = vi.fn();
  const state: Pick<RunState, "lastRun" | "availability"> = {
    lastRun: options.lastRun ?? null,
    availability: {
      runnable: options.view.enabled,
      kind: null,
      language: null,
      reason: null,
      previewable: options.previewable ?? false,
      runtimeMissing: false,
      runtime: null,
      command: null,
      resolved: null,
    },
  };
  harness.current = {
    run,
    runCode: {
      subscribe: () => () => undefined,
      getState: () => state,
      buttonView: () => options.view,
      activeEditor: () => ({
        tabId: "d",
        docId: "d",
        path: options.path ?? "C:/p/hello.py",
        dirty: false,
      }),
      isRunning: () => options.running ?? false,
    },
    runConfigs: { supports: () => options.configurable ?? true },
    workspace: { subscribe: () => () => undefined, getState: () => WORKSPACE_STATE },
  };
  return { run };
}

describe("RunCodeButton", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("is enabled when the file can run, shows the command in its tooltip, and runs on click", () => {
    const { run } = setup({ view: READY });
    render(<RunCodeButton />);

    const button = screen.getByRole("button", { name: "Run Code" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("Ctrl+F5"));
    expect(button).toHaveClass("run-button--ready");
    fireEvent.click(button);

    expect(run).toHaveBeenCalledWith("run.code");
  });

  it("is disabled with the reason in its tooltip for an unsupported file", () => {
    const { run } = setup({
      view: {
        state: "disabled",
        enabled: false,
        tooltip: "JSON files can't be run.",
        canStop: false,
      },
    });
    render(<RunCodeButton />);

    const button = screen.getByRole("button", { name: "Run Code" });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "JSON files can't be run.");
    fireEvent.click(button);
    expect(run).not.toHaveBeenCalled();
  });

  it("says the file must be saved when it is untitled", () => {
    setup({
      view: {
        state: "disabled",
        enabled: false,
        tooltip: "Save the file before running.",
        canStop: false,
      },
      path: null,
    });
    render(<RunCodeButton />);

    expect(screen.getByRole("button", { name: "Run Code" })).toHaveAttribute(
      "title",
      "Save the file before running.",
    );
  });

  it("flags a missing runtime, naming it in the tooltip", () => {
    setup({
      view: {
        state: "runtimeMissing",
        enabled: false,
        tooltip: "Python runtime is not installed.",
        canStop: false,
      },
    });
    render(<RunCodeButton />);

    const button = screen.getByRole("button", { name: "Run Code" });
    expect(button).toHaveClass("run-button--runtimeMissing");
    expect(button).toHaveAttribute("title", "Python runtime is not installed.");
  });

  it("becomes a Stop button while running, and stops on click", () => {
    const { run } = setup({
      view: {
        state: "running",
        enabled: true,
        tooltip: "Stop Running Code (Ctrl+Shift+F5)",
        canStop: true,
      },
      running: true,
    });
    render(<RunCodeButton />);

    const button = screen.getByRole("button", { name: "Stop Running Code" });
    expect(button).toHaveClass("run-button--running");
    fireEvent.click(button);

    expect(run).toHaveBeenCalledWith("run.stop");
  });

  it("shows a failed start as an error state that can be retried", () => {
    setup({
      view: {
        state: "error",
        enabled: true,
        tooltip: "Couldn't start — click to try again",
        canStop: false,
      },
    });
    render(<RunCodeButton />);

    expect(screen.getByRole("button", { name: "Run Code" })).toHaveClass("run-button--error");
    expect(screen.getByRole("button", { name: "Run Code" })).toBeEnabled();
  });
});

describe("RunCodeDropdown", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("opens the run menu with every action and runs the chosen command", () => {
    const { run } = setup({ view: READY });
    render(<RunCodeDropdown />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "Run Code options" }));
    const menu = screen.getByRole("menu", { name: "Run Code options" });
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);

    expect(items).toEqual([
      "Run Code",
      "Run Code in Terminal",
      "Run Code and Show Output",
      "Run Code with Arguments...",
      "Configure Run Command…",
      "Select Runtime…",
    ]);
    fireEvent.click(within(menu).getByText("Run Code in Terminal"));
    expect(run).toHaveBeenCalledWith("run.codeInTerminal");
  });

  it("adds Stop Running Code while something runs, and disables the run rows", () => {
    setup({
      view: { state: "running", enabled: true, tooltip: "Stop", canStop: true },
      running: true,
    });
    render(<RunCodeDropdown />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "Run Code options" }));

    expect(screen.getByText("Stop Running Code")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Run Code" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("disabled rows explain why on hover", () => {
    setup({
      view: {
        state: "runtimeMissing",
        enabled: false,
        tooltip: "Node.js runtime is not installed.",
        canStop: false,
      },
    });
    render(<RunCodeDropdown />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "Run Code options" }));

    expect(screen.getByRole("menuitem", { name: "Run Code and Show Output" })).toHaveAttribute(
      "title",
      "Node.js runtime is not installed.",
    );
    expect(screen.getByRole("menuitem", { name: "Select Runtime…" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});

describe("RunStatusIndicator", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("shows Running… while a run is in progress", () => {
    setup({ view: { state: "running", enabled: true, tooltip: "", canStop: true }, running: true });
    render(<RunStatusIndicator />);

    expect(screen.getByRole("status")).toHaveTextContent("Running…");
  });

  it("shows success or the exit code of the last run of this file", () => {
    setup({
      view: READY,
      lastRun: { path: "C:/p/hello.py", code: 0, stopped: false, durationMs: 250 },
    });
    const { unmount } = render(<RunStatusIndicator />);
    expect(screen.getByRole("status")).toHaveTextContent("✓ Done");
    unmount();

    setup({
      view: READY,
      lastRun: { path: "C:/p/hello.py", code: 2, stopped: false, durationMs: 250 },
    });
    render(<RunStatusIndicator />);
    expect(screen.getByRole("status")).toHaveTextContent("✗ Exit 2");
  });

  it("shows nothing for a different file's run, or a stopped run says Stopped", () => {
    setup({
      view: READY,
      lastRun: { path: "C:/p/other.py", code: 1, stopped: false, durationMs: 1 },
    });
    const { container, unmount } = render(<RunStatusIndicator />);
    expect(container).toBeEmptyDOMElement();
    unmount();

    setup({
      view: READY,
      lastRun: { path: "C:/p/hello.py", code: null, stopped: true, durationMs: 1000 },
    });
    render(<RunStatusIndicator />);
    expect(screen.getByRole("status")).toHaveTextContent("Stopped");
  });
});

describe("EditorHeaderActions", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("shows the run controls apart from the split and more-actions buttons in the active group", () => {
    setup({ view: READY });
    render(<EditorHeaderActions groupId="group-1" locked={false} hasTabs active />);

    const toolbar = screen.getByRole("toolbar", { name: "Editor actions" });
    const names = within(toolbar)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(["Run Code", "Run Code options", "Split Editor Right", "More Actions"]);
  });

  it("other groups only get split and more actions, and an empty group shows nothing", () => {
    setup({ view: READY });
    const { container, rerender } = render(
      <EditorHeaderActions groupId="group-2" locked={false} hasTabs active={false} />,
    );
    expect(screen.queryByRole("button", { name: "Run Code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Split Editor Right" })).toBeInTheDocument();

    rerender(<EditorHeaderActions groupId="group-2" locked={false} hasTabs={false} active />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("RunConfigurationDialog", () => {
  function dialogSetup(path = "C:/p/hello.py") {
    const settings = new Map<string, string>();
    const ipc = createFakeIpc({
      settingsGet: vi.fn((key: string) => Promise.resolve(settings.get(key) ?? null)),
      settingsSet: vi.fn((key: string, value: string) => {
        settings.set(key, value);
        return Promise.resolve();
      }),
    });
    const runConfigs = new RunConfigurationService(ipc);
    harness.current = {
      runConfigs,
      runCode: { activeEditor: () => ({ tabId: "d", docId: "d", path, dirty: false }) },
    };
    return { runConfigs };
  }

  beforeEach(() => {
    harness.current = null;
  });

  it("shows the current command and target for the file type and saves a change", async () => {
    const { runConfigs } = dialogSetup();
    const onClose = vi.fn();
    render(<RunConfigurationDialog onClose={onClose} />);

    expect(screen.getByLabelText("Run command")).toHaveValue('python "${file}"');
    fireEvent.change(screen.getByLabelText("Run command"), {
      target: { value: 'python -u "${file}"' },
    });
    fireEvent.change(screen.getByLabelText("Run target"), { target: { value: "terminal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(runConfigs.get(".py")).toEqual({
      command: 'python -u "${file}"',
      target: "terminal",
      custom: true,
    });
  });

  it("refuses an invalid command and keeps the dialog open with the reason", async () => {
    const { runConfigs } = dialogSetup();
    const onClose = vi.fn();
    render(<RunConfigurationDialog onClose={onClose} />);

    fireEvent.change(screen.getByLabelText("Run command"), { target: { value: "python a.py" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Include ${file}");
    expect(onClose).not.toHaveBeenCalled();
    expect(runConfigs.get(".py")?.custom).toBe(false);
  });

  it("Reset to Default removes the customization", async () => {
    const { runConfigs } = dialogSetup();
    await runConfigs.set(".py", 'python -u "${file}"', "output");
    const onClose = vi.fn();
    render(<RunConfigurationDialog onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to Default" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(runConfigs.get(".py")?.custom).toBe(false);
  });

  it("says so for a file type Run Code doesn't support", () => {
    dialogSetup("C:/p/data.json");
    render(<RunConfigurationDialog onClose={() => undefined} />);

    expect(screen.getByText(/doesn.t support this file type/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Run command")).toBeNull();
  });
});
