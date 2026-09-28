import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../services/commandRegistry";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { ShellInfo, ShellKind } from "../services/ipc";
import { OutputService } from "../services/outputService";
import { PanelService } from "../services/panelService";
import { PortsService } from "../services/portsService";
import { registerTerminalCommands } from "../services/terminalCommands";
import { TerminalService } from "../services/terminalService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));
vi.mock("./XtermHost", () => ({
  XtermHost: ({ id, active }: { id: string; active: boolean }) => (
    <div data-testid={`xterm-${id}`} data-active={String(active)} />
  ),
}));

import { BottomPanel } from "./BottomPanel";

/** Stands in for MarkerService, which would pull Monaco (and its global listeners) into the test. */
const FAKE_MARKERS = {
  subscribe: () => () => undefined,
  getCounts: () => ({ errors: 0, warnings: 0 }),
  getProblemFiles: () => [],
};

/** No proxy configured (the terminal header's network label). */
const NETWORK_STATE = { status: null, offline: [], staleTerminals: [] };
const FAKE_NETWORK = {
  subscribe: () => () => undefined,
  getState: () => NETWORK_STATE,
};

const POWERSHELL: ShellInfo = { kind: "powerShell", label: "PowerShell", available: true };
const CMD: ShellInfo = { kind: "cmd", label: "Command Prompt", available: true };

describe("BottomPanel", () => {
  let terminal: TerminalService;
  let panel: PanelService;
  let output: OutputService;
  let ports: PortsService;
  let exitHandler: (id: string, code: number | null) => void;
  let ipc: ReturnType<typeof createFakeIpc>;
  let run: ReturnType<typeof vi.fn>;
  let counter: number;

  async function setup(shells: ShellInfo[] = [POWERSHELL, CMD], saved: string | null = null) {
    counter = 0;
    ipc = createFakeIpc({
      settingsGet: vi.fn().mockResolvedValue(saved),
      terminalListShells: vi.fn().mockResolvedValue(shells),
      terminalCreate: vi.fn((kind: ShellKind | null) =>
        Promise.resolve({
          id: `t${String(++counter)}`,
          shell: kind ?? "powerShell",
          cwd: "C:/p",
          pid: 1,
        }),
      ),
      onTerminalExit: vi.fn((handler: typeof exitHandler) => {
        exitHandler = handler;
        return Promise.resolve(() => undefined);
      }),
    });
    const events = new EventBus<AppEvents>();
    panel = new PanelService(ipc);
    output = new OutputService();
    ports = new PortsService(ipc, events);
    terminal = new TerminalService(ipc, events, () => "C:/p", panel);
    await panel.initialize();
    await terminal.initialize();
    const commands = new CommandRegistry();
    registerTerminalCommands(commands, terminal);
    run = vi.fn((id: string, ...args: unknown[]) => {
      void commands.execute(id, ...args);
    });
    harness.current = { terminal, panel, output, ports, markers: FAKE_MARKERS, run, network: FAKE_NETWORK };
  }

  const terminalTabs = () => screen.getByRole("tablist", { name: "Terminals" });

  beforeEach(() => {
    harness.current = null;
  });

  it("renders nothing until a terminal exists or the panel was left open", async () => {
    await setup();
    const { container } = render(<BottomPanel themeKind="dark" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("offers New Terminal in a panel the user opened that has no terminals yet", async () => {
    await setup([POWERSHELL, CMD], '{"visible":true}');
    await panel.show("terminal");
    render(<BottomPanel themeKind="dark" />);

    fireEvent.click(screen.getByRole("button", { name: "New Terminal", description: "" }));

    expect(run).toHaveBeenCalledWith("terminal.new");
    expect(screen.getByRole("button", { name: "Clear Terminal" })).toBeDisabled();
  });

  it("shows an exited terminal's tab with an exited indicator and exit code", async () => {
    await setup();
    const id = (await terminal.createTerminal()) ?? "";
    render(<BottomPanel themeKind="dark" />);
    expect(screen.queryByText("exited")).not.toBeInTheDocument();

    exitHandler(id, 3);

    await waitFor(() => {
      expect(screen.getByText("exited")).toBeInTheDocument();
    });
    expect(within(terminalTabs()).getByRole("tab")).toHaveAttribute(
      "title",
      expect.stringContaining("code 3"),
    );
  });

  it("closing an exited terminal removes its tab without error", async () => {
    await setup();
    const id = (await terminal.createTerminal()) ?? "";
    render(<BottomPanel themeKind="dark" />);
    exitHandler(id, 0);

    fireEvent.click(await screen.findByRole("button", { name: /Close PowerShell/ }));

    await waitFor(() => {
      expect(ipc.terminalClose).toHaveBeenCalledWith(id);
    });
    expect(terminal.getState().sessions).toHaveLength(0);
  });

  it("marks only the active session's view active and switches on tab click", async () => {
    await setup();
    const first = (await terminal.createTerminal()) ?? "";
    const second = (await terminal.createTerminal("cmd")) ?? "";
    render(<BottomPanel themeKind="dark" />);
    expect(screen.getByTestId(`xterm-${second}`)).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId(`xterm-${first}`)).toHaveAttribute("data-active", "false");

    fireEvent.click(within(terminalTabs()).getAllByRole("tab")[0] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByTestId(`xterm-${first}`)).toHaveAttribute("data-active", "true");
    });
  });

  it("shell selector lists the available shells and creates a terminal with the chosen one", async () => {
    await setup();
    await terminal.createTerminal();
    render(<BottomPanel themeKind="dark" />);

    fireEvent.mouseDown(screen.getByRole("button", { name: "Select shell for new terminal" }));
    fireEvent.click(await screen.findByText("Command Prompt"));

    expect(run).toHaveBeenCalledWith("terminal.new", "cmd");
  });

  it("hides the shell selector when there is only one shell to choose", async () => {
    await setup([POWERSHELL]);
    await terminal.createTerminal();
    render(<BottomPanel themeKind="dark" />);

    expect(
      screen.queryByRole("button", { name: "Select shell for new terminal" }),
    ).not.toBeInTheDocument();
  });
});
