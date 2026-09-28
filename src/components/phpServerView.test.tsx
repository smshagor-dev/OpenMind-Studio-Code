import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../services/commandRegistry";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { InstalledVersion, RuntimeStatus } from "../services/ipc";
import { ComposerService } from "../services/composerService";
import { MariaDbService } from "../services/mariaDbService";
import { OutputService } from "../services/outputService";
import { PanelService } from "../services/panelService";
import { registerPhpCommands } from "../services/phpCommands";
import { PhpMyAdminService } from "../services/phpMyAdminService";
import { PhpRuntimeService } from "../services/phpRuntimeService";
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

function installed(version: string, healthy = true, active = true): InstalledVersion {
  return { version, path: "C:/x", active, healthy, features: [] };
}

function status(id: string, versions: InstalledVersion[], available: string[] = []): RuntimeStatus {
  return {
    id,
    displayName: id,
    description: "",
    notes: "",
    defaultVersion: "1",
    availableVersions: [...versions.map((v) => v.version), ...available],
    installed: versions,
    activeVersion: versions.find((v) => v.active)?.version ?? null,
    globalVersion: null,
    requires: [],
    license: null,
    downloadBytes: null,
    installBytes: null,
    busy: false,
  };
}

const PHP_LINES = ["8.4.26", "8.3.35", "8.2.34", "8.1.34", "8.0.30"];

async function setup(runtimes: RuntimeStatus[], hasFolder = true) {
  const ipc = createFakeIpc({
    runtimeList: vi.fn().mockResolvedValue(runtimes),
    phpWebRoot: hasFolder
      ? vi.fn().mockResolvedValue("C:/My Site")
      : vi.fn().mockRejectedValue("Couldn't create the web root folder: access denied"),
  });
  const events = new EventBus<AppEvents>();
  const output = new OutputService();
  const ports = new PortsService(ipc, events);
  const runtime = new RuntimeService(ipc, events, () => undefined);
  await runtime.refresh();
  const php = new PhpServerService(ipc, events, output, runtime, ports, new PanelService(ipc));
  await php.initialize();
  const commands = new CommandRegistry();
  registerPhpCommands(commands, php, ipc);
  const run = vi.fn((id: string) => {
    void commands.execute(id);
  });
  const panel = new PanelService(ipc);
  const mariaDb = new MariaDbService(ipc, events, output, runtime, ports, panel);
  const phpMyAdmin = new PhpMyAdminService(
    ipc,
    events,
    output,
    runtime,
    ports,
    panel,
    php,
    mariaDb,
  );
  const composer = new ComposerService(ipc, events, output, runtime, panel);
  harness.current = {
    php,
    mariaDb,
    phpMyAdmin,
    composer,
    ipc,
    phpRuntime: new PhpRuntimeService(runtime, php, { mariadb: mariaDb, pma: phpMyAdmin }),
    runtime,
    output,
    run,
  };
  return { php, runtime, output, ports, ipc, run };
}

describe("PhpServerView", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("with nothing installed: Start is disabled with a visible reason and PHP can be installed from the cards", async () => {
    const { php } = await setup([status("php", [], PHP_LINES), status("composer", [], ["2.10.3"])]);
    await php.useDefaultRoot();
    render(<PhpServerView />);

    const start = screen.getByRole("button", { name: "Start Server" });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute("title", "PHP runtime is not installed yet.");
    expect(
      within(screen.getByRole("region", { name: "Server" })).getByRole("note"),
    ).toHaveTextContent("PHP runtime is not installed yet.");
    expect(screen.getByRole("button", { name: "Install PHP 8.4.26" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Install PHP 8.0.30" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop Server" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open Browser" })).toBeDisabled();
  });

  it("Composer can't be installed before PHP, and says why", async () => {
    await setup([status("php", [], PHP_LINES), status("composer", [], ["2.10.3"])]);
    render(<PhpServerView />);

    const install = screen.getByRole("button", { name: "Install Composer 2.10.3" });
    expect(install).toBeDisabled();
    expect(install).toHaveAttribute("title", "Install PHP first — Composer runs on it.");
  });

  it("Install PHP asks the Runtime Manager for that version", async () => {
    const { runtime } = await setup([status("php", [], PHP_LINES)]);
    const install = vi.spyOn(runtime, "install").mockResolvedValue(true);
    render(<PhpServerView />);

    fireEvent.click(screen.getByRole("button", { name: "Install PHP 8.3.35" }));

    expect(install).toHaveBeenCalledWith("php", "8.3.35");
  });

  it("without a web root Start is disabled with the folder reason", async () => {
    await setup([status("php", [installed("8.4.26")])], false);
    render(<PhpServerView />);

    expect(screen.getByRole("button", { name: "Start Server" })).toBeDisabled();
    expect(
      within(screen.getByRole("region", { name: "Server" })).getByRole("note"),
    ).toHaveTextContent("Choose a web root folder first.");
    expect(
      within(screen.getByRole("region", { name: "Web Root" })).getByText("Not set"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Default (htdocs)" })).toBeEnabled();
  });

  it("serves the default web root, and Change Folder picks another one", async () => {
    const { ipc } = await setup([status("php", [installed("8.4.26")])]);
    render(<PhpServerView />);

    const webRoot = within(screen.getByRole("region", { name: "Web Root" }));
    expect(webRoot.getByText("Served folder (default)")).toBeInTheDocument();
    expect(webRoot.getByText("C:/My Site")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Default (htdocs)" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Use Open Folder" })).toBeNull();

    vi.mocked(ipc.openFolderDialog).mockResolvedValue("D:/Sites");
    fireEvent.click(screen.getByRole("button", { name: "Change Folder…" }));
    expect(await webRoot.findByText("D:/Sites")).toBeInTheDocument();
    expect(webRoot.getByText("Served folder")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Default (htdocs)" })).toBeEnabled();
  });

  it("shows the PHP and Composer versions, and lists only Apache as not available", async () => {
    await setup([status("php", [installed("8.4.26")]), status("composer", [installed("2.10.3")])]);
    render(<PhpServerView />);

    const php = within(screen.getByRole("article", { name: "PHP" }));
    expect(php.getByText("Installed — active 8.4.26")).toBeInTheDocument();
    const composer = within(screen.getByRole("article", { name: "Composer" }));
    expect(composer.getByText("Installed — active 2.10.3")).toBeInTheDocument();
    expect(screen.getByText("Apache")).toBeInTheDocument();
    expect(screen.getAllByText("Not available yet")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Apache/ })).toBeNull();
    expect(screen.getByRole("region", { name: "Database" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "phpMyAdmin" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Composer" })).toBeInTheDocument();
  });

  it("Start Server serves the web root and the running state shows the URL", async () => {
    const { ipc } = await setup([status("php", [installed("8.4.26")])]);
    render(<PhpServerView />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start Server" })).toBeEnabled();
    });

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
    expect(screen.getByText(/Bound to 127\.0\.0\.1 only/)).toBeInTheDocument();
  });

  it("a busy port is shown as busy and blocks Start with the port in the reason", async () => {
    const { php, ipc } = await setup([status("php", [installed("8.4.26")])]);
    vi.mocked(ipc.phpPortFree).mockResolvedValue(false);
    await php.useDefaultRoot();
    await php.refreshPort();
    render(<PhpServerView />);

    expect(screen.getByText(/Busy — another program/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Server" })).getByRole("note"),
    ).toHaveTextContent("Port 8000 is already in use");
  });

  it("renders the recent server log, or an empty hint", async () => {
    const { output } = await setup([status("php", [installed("8.4.26")])]);
    const { rerender } = render(<PhpServerView />);
    expect(screen.getByText(/No PHP Server output yet/)).toBeInTheDocument();

    output.append(PHP_CHANNEL, "[PHP Server] php -S 127.0.0.1:8000");
    output.append(PHP_CHANNEL, "GET / [200]");
    rerender(<PhpServerView />);

    const logs = screen.getByRole("region", { name: "Logs" });
    expect(within(logs).getByText(/GET \/ \[200\]/)).toBeInTheDocument();
  });

  it("a damaged PHP shows 'needs repair', offers Repair on the card, and Start points at it", async () => {
    await setup([status("php", [installed("8.4.26", false)])]);
    render(<PhpServerView />);

    expect(screen.getByText("needs repair")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repair PHP 8.4.26" })).toBeEnabled();
    expect(
      within(screen.getByRole("region", { name: "Server" })).getByRole("note"),
    ).toHaveTextContent("repair it");
  });

  it("after switching PHP under a running server a restart notice appears and the running PHP is protected", async () => {
    const { php, runtime, ipc } = await setup([
      status("php", [installed("8.4.26"), installed("8.3.35", true, false)]),
    ]);
    vi.mocked(ipc.phpServerStart).mockResolvedValue({
      run: { runId: "php-1", file: "", pid: 1 },
      url: "http://127.0.0.1:8000",
      port: 8000,
      phpVersion: "8.4.26",
    });
    await php.useDefaultRoot();
    await php.start();
    vi.mocked(ipc.runtimeList).mockResolvedValue([
      status("php", [installed("8.4.26", true, false), installed("8.3.35")]),
    ]);
    await runtime.refresh();
    render(<PhpServerView />);

    expect(
      screen.getAllByText(/Restart the PHP server to use the new PHP version/).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Delete PHP 8.4.26" })).toBeDisabled();
  });
});
