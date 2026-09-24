import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../services/commandRegistry";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { InstalledVersion, RuntimeStatus } from "../services/ipc";
import { OutputService } from "../services/outputService";
import { PanelService } from "../services/panelService";
import { registerPhpCommands } from "../services/phpCommands";
import { PHP_CHANNEL, PhpServerService } from "../services/phpServerService";
import { PortsService } from "../services/portsService";
import { RuntimeService } from "../services/runtimeService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { PhpServerView } from "./PhpServerView";

function installed(version: string, healthy = true): InstalledVersion {
  return { version, path: "C:/x", active: true, healthy, features: [] };
}

function status(id: string, versions: InstalledVersion[]): RuntimeStatus {
  return {
    id,
    displayName: id,
    description: "",
    notes: "",
    defaultVersion: "1",
    availableVersions: [],
    installed: versions,
    activeVersion: versions[0]?.version ?? null,
    globalVersion: null,
    busy: false,
  };
}

async function setup(runtimes: RuntimeStatus[], workspace: string | null = "C:/My Site") {
  const ipc = createFakeIpc({ runtimeList: vi.fn().mockResolvedValue(runtimes) });
  const events = new EventBus<AppEvents>();
  const output = new OutputService();
  const ports = new PortsService(ipc, events);
  const runtime = new RuntimeService(ipc, events, () => undefined);
  await runtime.refresh();
  const php = new PhpServerService(
    ipc,
    events,
    output,
    runtime,
    ports,
    new PanelService(ipc),
    () => workspace,
  );
  await php.initialize();
  const commands = new CommandRegistry();
  registerPhpCommands(commands, php);
  const run = vi.fn((id: string) => {
    void commands.execute(id);
  });
  harness.current = {
    php,
    runtime,
    output,
    run,
    workspace: { getActiveWorkspace: () => (workspace === null ? null : { path: workspace }) },
  };
  return { php, runtime, output, ports, ipc, run };
}

describe("PhpServerView", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("with nothing installed: PHP and Composer are 'Not installed', Start is disabled with a visible reason", async () => {
    const { php } = await setup([]);
    await php.useWorkspace();
    render(<PhpServerView />);

    expect(screen.getAllByText("Not installed")).toHaveLength(2);
    const start = screen.getByRole("button", { name: "Start Server" });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute("title", "PHP runtime is not installed yet.");
    expect(screen.getByRole("note")).toHaveTextContent("PHP runtime is not installed yet.");
    expect(screen.getByRole("button", { name: "Install PHP" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop Server" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Browser" })).toBeDisabled();
  });

  it("Composer can't be installed before PHP, and says why", async () => {
    await setup([]);
    render(<PhpServerView />);

    const install = screen.getByRole("button", { name: "Install Composer" });
    expect(install).toBeDisabled();
    expect(install).toHaveAttribute("title", "Install PHP first — Composer runs on it.");
  });

  it("Install PHP asks the Runtime Manager to install php", async () => {
    const { runtime } = await setup([]);
    const install = vi.spyOn(runtime, "install").mockResolvedValue(true);
    render(<PhpServerView />);

    fireEvent.click(screen.getByRole("button", { name: "Install PHP" }));

    expect(install).toHaveBeenCalledWith("php", null);
  });

  it("without a project folder Start is disabled with the folder reason", async () => {
    await setup([status("php", [installed("8.4.26")])], null);
    render(<PhpServerView />);

    expect(screen.getByRole("button", { name: "Start Server" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("Select a valid project folder first.");
    expect(screen.getByRole("button", { name: "Use Current Workspace" })).toBeDisabled();
    expect(screen.getByText("No folder selected")).toBeInTheDocument();
  });

  it("shows PHP and Composer versions, and lists Apache, MariaDB and phpMyAdmin as not available", async () => {
    await setup([status("php", [installed("8.4.26")]), status("composer", [installed("2.10.3")])]);
    render(<PhpServerView />);

    expect(screen.getByText("Installed — 8.4.26")).toBeInTheDocument();
    expect(screen.getByText("Installed — 2.10.3")).toBeInTheDocument();
    for (const name of ["Apache", "MariaDB", "phpMyAdmin"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getAllByText("Not available yet")).toHaveLength(3);
    // No fake controls for them.
    expect(screen.queryByRole("button", { name: /Apache|MariaDB|phpMyAdmin/ })).toBeNull();
  });

  it("with PHP and a folder, Use Current Workspace then Start Server starts it and the running state shows the URL", async () => {
    const { ipc } = await setup([status("php", [installed("8.4.26")])]);
    render(<PhpServerView />);

    fireEvent.click(screen.getByRole("button", { name: "Use Current Workspace" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start Server" })).toBeEnabled();
    });
    expect(screen.getByText("C:/My Site")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start Server" }));
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "http://127.0.0.1:8000" })).toBeInTheDocument();
    });
    expect(ipc.phpServerStart).toHaveBeenCalledWith({ root: "C:/My Site", port: 8000 });
    expect(screen.getByRole("button", { name: "Stop Server" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restart Server" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open Browser" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start Server" })).toBeDisabled();
    expect(screen.getByLabelText("PHP built-in server")).toBeDisabled();
  });

  it("shows the port, whether it is free, and rejects a bad one with a message", async () => {
    await setup([status("php", [installed("8.4.26")])]);
    render(<PhpServerView />);

    const port = screen.getByLabelText("PHP built-in server");
    expect(port).toHaveValue("8000");
    await waitFor(() => {
      expect(screen.getByText("Free")).toBeInTheDocument();
    });
    fireEvent.change(port, { target: { value: "22" } });
    fireEvent.blur(port);
    expect(await screen.findByText(/Choose a port from 1024 to 65535/)).toBeInTheDocument();
    expect(screen.getByText(/127\.0\.0\.1 only/)).toBeInTheDocument();
  });

  it("a busy port is shown as busy and blocks Start with the port in the reason", async () => {
    const { php, ipc } = await setup([status("php", [installed("8.4.26")])]);
    vi.mocked(ipc.phpPortFree).mockResolvedValue(false);
    await php.useWorkspace();
    await php.refreshPort();
    render(<PhpServerView />);

    expect(screen.getByText(/Busy — another program/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Port 8000 is already in use");
  });

  it("renders the recent server log, or an empty hint", async () => {
    const { output } = await setup([status("php", [installed("8.4.26")])]);
    const { rerender } = render(<PhpServerView />);
    expect(screen.getByText(/No server output yet/)).toBeInTheDocument();

    output.append(PHP_CHANNEL, "[PHP Server] php -S 127.0.0.1:8000");
    output.append(PHP_CHANNEL, "GET / [200]");
    rerender(<PhpServerView />);

    const logs = screen.getByRole("region", { name: "Logs" });
    expect(within(logs).getByText(/GET \/ \[200\]/)).toBeInTheDocument();
  });

  it("a damaged PHP shows 'Needs repair' and offers Repair PHP", async () => {
    await setup([status("php", [installed("8.4.26", false)])]);
    render(<PhpServerView />);

    expect(screen.getByText("Needs repair (8.4.26)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repair PHP" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete PHP" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Install PHP" })).toBeDisabled();
  });
});
