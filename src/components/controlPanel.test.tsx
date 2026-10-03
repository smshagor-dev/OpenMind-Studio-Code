import { connectBackend } from "../testUtils/canonicalFeeds";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlPanelService } from "../services/controlPanelService";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { RuntimeStatus } from "../services/ipc";
import { MariaDbService } from "../services/mariaDbService";
import { MySqlService } from "../services/mySqlService";
import { OutputService } from "../services/outputService";
import { PanelService } from "../services/panelService";
import { PhpMyAdminService } from "../services/phpMyAdminService";
import { PhpServerService } from "../services/phpServerService";
import { PortsService } from "../services/portsService";
import { RuntimeService } from "../services/runtimeService";
import { PhpRuntimeService } from "../services/phpRuntimeService";
import { createFakeIpc, STOPPED_MYSQL } from "../testUtils/fakeIpcClient";

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
  requires: [],
  license: null,
  downloadBytes: null,
  installBytes: null,
  busy: false,
};

async function setup(overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const ipc = createFakeIpc({
    runtimeList: vi.fn().mockResolvedValue([PHP]),
    ...overrides,
    panelNetstat: vi
      .fn()
      .mockResolvedValue([{ address: "0.0.0.0", port: 135, pid: 1548, process: "svchost.exe" }]),
  });
  const events = new EventBus<AppEvents>();
  const output = new OutputService();
  const ports = new PortsService(ipc, events);
  const runtime = new RuntimeService(ipc, events, () => undefined);
  const feeds = connectBackend(ipc, { runtime, ports });
  await runtime.refresh();
  const panel = new PanelService(ipc);
  const php = new PhpServerService(ipc, events, output, runtime, panel);
  php.useCanonical(feeds.servers);
  await php.initialize();
  const mariaDb = new MariaDbService(ipc, events, output, runtime, panel);
  const pma = new PhpMyAdminService(ipc, events, output, runtime, panel, php, mariaDb);
  const mySql = new MySqlService(ipc, events, output);
  mySql.useCanonical(feeds.servers);
  await mySql.initialize();
  const controlPanel = new ControlPanelService(ipc, events, output, php, mySql, () =>
    Promise.resolve(),
  );
  await controlPanel.initialize();
  const phpRuntime = new PhpRuntimeService(runtime, php, { mariadb: mariaDb, pma });
  harness.current = { controlPanel, php, mariaDb, phpMyAdmin: pma, mySql, runtime, phpRuntime };
  return { controlPanel, output };
}

describe("ControlPanel", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("lists exactly two servers, PHP and MySQL — no separate MariaDB or phpMyAdmin rows", async () => {
    await setup();
    render(<ControlPanel />);

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["PHP", "MySQL"]);
    for (const name of ["PHP", "MySQL"]) {
      const row = within(screen.getByRole("row", { name }));
      expect(row.getByRole("button", { name: `Start ${name}` })).toBeInTheDocument();
      expect(row.getByRole("button", { name: `Logs ${name}` })).toBeEnabled();
    }
    expect(screen.getByRole("button", { name: "Admin PHP" })).toBeDisabled();
    // With everything installed, Open phpMyAdmin is available (it starts MySQL first).
    expect(screen.getByRole("button", { name: "Open phpMyAdmin" })).toBeEnabled();
    expect(screen.queryByRole("row", { name: "MariaDB" })).toBeNull();
    expect(screen.queryByRole("row", { name: "phpMyAdmin" })).toBeNull();
    expect(screen.getByText(/MySQL: MariaDB 11\.8\.9 · phpMyAdmin 5\.2\.3/)).toBeInTheDocument();
    for (const label of ["Config", "Netstat", "Shell", "Explorer", "Help", "Quit"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // The web root always exists, so Explorer can open it.
    expect(screen.getByRole("button", { name: "Explorer" })).toBeEnabled();
    expect(screen.getByRole("log", { name: "Log" })).toHaveTextContent("Control Panel Ready");
  });

  it("colors a running module green, XAMPP style, and shows its PID and port", async () => {
    await setup({
      phpServerStatus: vi.fn().mockResolvedValue({
        run: { runId: "r1", file: "C:/site", pid: 4242 },
        url: "http://127.0.0.1:8000",
        port: 8000,
        phpVersion: "8.4.26",
      }),
    });
    render(<ControlPanel />);

    const php = screen.getByRole("row", { name: "PHP" });
    const name = within(php).getByRole("rowheader");
    expect(name).toHaveClass("cp__module--running");
    expect(name).toHaveAttribute("title", "Running");
    expect(php).toHaveTextContent("4242");
    expect(php).toHaveTextContent("8000");
    expect(within(php).getByRole("button", { name: "Stop PHP" })).toBeEnabled();
    const db = within(screen.getByRole("row", { name: "MySQL" })).getByRole("rowheader");
    expect(db).not.toHaveClass("cp__module--running");
    expect(db).toHaveAttribute("title", "Stopped");
  });

  it("MySQL running shows MariaDB's PID, both ports and the engine's real name", async () => {
    await setup({
      mysqlStatus: vi.fn().mockResolvedValue({
        ...STOPPED_MYSQL,
        state: "running",
        mariadb: { run: { runId: "m", file: "", pid: 5150 }, port: 3306, url: null, ready: true, version: "11.8.9", phpVersion: null },
        phpmyadmin: { run: { runId: "p", file: "", pid: 5151 }, port: 8081, url: "http://127.0.0.1:8081", ready: true, version: "5.2.3", phpVersion: "8.4.26" },
      }),
    });
    render(<ControlPanel />);
    const row = await screen.findByRole("row", { name: "MySQL" });
    await vi.waitFor(() => {
      expect(within(row).getByRole("rowheader")).toHaveClass("cp__module--running");
    });
    expect(row).toHaveTextContent("5150");
    expect(row).toHaveTextContent("3306, 8081");
    expect(within(row).getByRole("button", { name: "Stop MySQL" })).toBeEnabled();
    expect(screen.getByText(/127\.0\.0\.1:3306/)).toHaveTextContent("user root, password root");
  });

  it("a disabled Start explains in its tooltip what is not installed", async () => {
    await setup({
      mysqlStatus: vi.fn().mockResolvedValue({
        ...STOPPED_MYSQL,
        missing: ["MariaDB", "phpMyAdmin"],
        state: "notInstalled",
      }),
    });
    render(<ControlPanel />);
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: "Start MySQL" })).toHaveAttribute(
        "title",
        "Not installed yet: MariaDB, phpMyAdmin. Install it with Config > Install.",
      );
    });
  });

  it("shows why MySQL isn't running when half of it failed", async () => {
    await setup({
      mysqlStatus: vi.fn().mockResolvedValue({
        ...STOPPED_MYSQL,
        state: "error",
        error: "MariaDB is running, but phpMyAdmin could not start: Port 8081 is already in use.",
        mariadb: { run: { runId: "m", file: "", pid: 7 }, port: 3306, url: null, ready: true, version: null, phpVersion: null },
      }),
    });
    render(<ControlPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "MySQL: MariaDB is running, but phpMyAdmin could not start",
    );
    const name = within(screen.getByRole("row", { name: "MySQL" })).getByRole("rowheader");
    expect(name).toHaveClass("cp__module--error");
    // Stop can still end the half that runs.
    expect(screen.getByRole("button", { name: "Stop MySQL" })).toBeEnabled();
  });

  it("Logs filters the log and the filter can be cleared", async () => {
    const { output } = await setup();
    render(<ControlPanel />);
    output.append("MariaDB", "db line");
    output.append("phpMyAdmin", "pma line");
    output.append("PHP Server", "php line");

    fireEvent.click(screen.getByRole("button", { name: "Logs MySQL" }));
    const log = screen.getByRole("log", { name: "Log" });
    expect(log).toHaveTextContent("db line");
    expect(log).toHaveTextContent("pma line");
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
    // The page has its own title, one line of subtitle and a chip per part of the stack.
    expect(screen.getByRole("heading", { name: "Configuration" })).toBeInTheDocument();
    expect(
      screen.getByText("Manage your local PHP stack, web root, database and admin tools."),
    ).toBeInTheDocument();
    const chips = within(screen.getByRole("list", { name: "Stack status" }));
    expect(chips.getByText(/^PHP: /)).toBeInTheDocument();
    expect(chips.getByText("MariaDB: Not installed")).toBeInTheDocument();
    expect(chips.getByText("phpMyAdmin: Not installed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("row", { name: "MySQL" })).toBeInTheDocument();
  });
});
