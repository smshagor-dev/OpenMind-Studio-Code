import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlPanelService } from "../services/controlPanelService";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { RuntimeStatus } from "../services/ipc";
import { MariaDbService } from "../services/mariaDbService";
import { OutputService } from "../services/outputService";
import { PanelService } from "../services/panelService";
import { PhpMyAdminService } from "../services/phpMyAdminService";
import { PhpServerService } from "../services/phpServerService";
import { PortsService } from "../services/portsService";
import { RuntimeService } from "../services/runtimeService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));
// The Config page embeds the full server view; it has its own tests.
vi.mock("./PhpServerView", () => ({ PhpServerView: () => <div>server view</div> }));

import { ControlPanel } from "./ControlPanel";

const PHP: RuntimeStatus = {
  id: "php",
  displayName: "php",
  description: "",
  notes: "",
  defaultVersion: "8.4.26",
  availableVersions: ["8.4.26"],
  installed: [{ version: "8.4.26", path: "C:/x", active: true, healthy: true, features: [] }],
  activeVersion: "8.4.26",
  globalVersion: null,
  busy: false,
};

async function setup() {
  const ipc = createFakeIpc({
    runtimeList: vi.fn().mockResolvedValue([PHP]),
    panelNetstat: vi
      .fn()
      .mockResolvedValue([{ address: "0.0.0.0", port: 135, pid: 1548, process: "svchost.exe" }]),
  });
  const events = new EventBus<AppEvents>();
  const output = new OutputService();
  const ports = new PortsService(ipc, events);
  const runtime = new RuntimeService(ipc, events, () => undefined);
  await runtime.refresh();
  const panel = new PanelService(ipc);
  const php = new PhpServerService(ipc, events, output, runtime, ports, panel);
  await php.initialize();
  const mariaDb = new MariaDbService(ipc, events, output, runtime, ports, panel);
  const pma = new PhpMyAdminService(ipc, events, output, runtime, ports, panel, php, mariaDb);
  const controlPanel = new ControlPanelService(ipc, events, output, php, mariaDb, pma, () =>
    Promise.resolve(),
  );
  await controlPanel.initialize();
  harness.current = { controlPanel, php, mariaDb, phpMyAdmin: pma, runtime };
  return { controlPanel, output };
}

describe("ControlPanel", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("shows one row per module with Start, Admin, Config and Logs, and the side buttons", async () => {
    await setup();
    render(<ControlPanel />);

    for (const name of ["PHP Server", "MariaDB", "phpMyAdmin"]) {
      const row = within(screen.getByRole("row", { name }));
      expect(row.getByRole("button", { name: `Start ${name}` })).toBeInTheDocument();
      expect(row.getByRole("button", { name: `Admin ${name}` })).toBeDisabled();
      expect(row.getByRole("button", { name: `Logs ${name}` })).toBeEnabled();
    }
    for (const label of ["Config", "Netstat", "Shell", "Explorer", "Help", "Quit"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Explorer" })).toBeDisabled();
    expect(screen.getByRole("log", { name: "Log" })).toHaveTextContent("Control Panel Ready");
  });

  it("a disabled button explains itself in its tooltip", async () => {
    await setup();
    render(<ControlPanel />);
    expect(screen.getByRole("button", { name: "Start MariaDB" })).toHaveAttribute(
      "title",
      "MariaDB runtime is not installed yet.",
    );
  });

  it("Logs filters the log and the filter can be cleared", async () => {
    const { output } = await setup();
    render(<ControlPanel />);
    output.append("MariaDB", "db line");
    output.append("PHP Server", "php line");

    fireEvent.click(screen.getByRole("button", { name: "Logs MariaDB" }));
    const log = screen.getByRole("log", { name: "Log" });
    expect(log).toHaveTextContent("db line");
    expect(log).not.toHaveTextContent("php line");
    fireEvent.click(screen.getByRole("button", { name: "show all" }));
    expect(log).toHaveTextContent("php line");
  });

  it("Netstat, Help and Config are pages with a Back button", async () => {
    await setup();
    render(<ControlPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Netstat" }));
    expect(await screen.findByText("svchost.exe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByText(/Everything listens on 127\.0\.0\.1 only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    fireEvent.click(screen.getByRole("button", { name: "Config" }));
    expect(screen.getByText("server view")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("row", { name: "MariaDB" })).toBeInTheDocument();
  });
});
