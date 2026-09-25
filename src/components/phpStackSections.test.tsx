import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../services/commandRegistry";
import { ComposerService } from "../services/composerService";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { InstalledVersion, RuntimeStatus } from "../services/ipc";
import { MariaDbService } from "../services/mariaDbService";
import { OutputService } from "../services/outputService";
import { PanelService } from "../services/panelService";
import { registerPhpCommands } from "../services/phpCommands";
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

import {
  ComposerSection,
  DatabaseSection,
  LogsSection,
  PhpMyAdminSection,
} from "./PhpStackSections";

function installed(version: string): InstalledVersion {
  return { version, path: "C:/x", active: true, healthy: true, features: [] };
}

function status(id: string, versions: InstalledVersion[]): RuntimeStatus {
  return {
    id,
    displayName: id,
    description: "",
    notes: "",
    defaultVersion: "1",
    availableVersions: versions.map((v) => v.version),
    installed: versions,
    activeVersion: versions[0]?.version ?? null,
    globalVersion: null,
    busy: false,
  };
}

async function setup(
  runtimes: RuntimeStatus[],
  overrides: Parameters<typeof createFakeIpc>[0] = {},
) {
  const ipc = createFakeIpc({
    runtimeList: vi.fn().mockResolvedValue(runtimes),
    phpWebRoot: vi.fn().mockResolvedValue("C:/My Site"),
    mariadbStatus: vi.fn().mockResolvedValue({
      initialized: true,
      running: null,
      dataDir: "C:/My Studio/data/mariadb",
      logDir: "C:/My Studio/logs/mariadb",
      configFile: "C:/My Studio/settings/mariadb/my.ini",
      hasPassword: true,
    }),
    ...overrides,
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
  await mariaDb.initialize();
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
  await phpMyAdmin.initialize();
  const composer = new ComposerService(ipc, events, output, runtime, panel);
  await composer.initialize();
  harness.current = { php, mariaDb, phpMyAdmin, composer, runtime, output, ipc };
  return { ipc, php, mariaDb, output, events };
}

describe("Database section", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("not installed: every button is disabled with its reason and the status says so", async () => {
    await setup([status("php", [installed("8.4.26")])], {
      mariadbStatus: vi.fn().mockResolvedValue({
        initialized: false,
        running: null,
        dataDir: "C:/My Studio/data/mariadb",
        logDir: "",
        configFile: "",
        hasPassword: false,
      }),
    });
    render(<DatabaseSection />);

    expect(screen.getAllByText("Not installed")).toHaveLength(2); // status and version
    const start = screen.getByRole("button", { name: "Start MariaDB" });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute("title", "MariaDB runtime is not installed yet.");
    expect(screen.getByRole("button", { name: "Stop MariaDB" })).toHaveAttribute(
      "title",
      expect.stringContaining("isn't running"),
    );
    expect(screen.getByRole("button", { name: "Show Password" })).toBeDisabled();
  });

  it("installed and initialized: Start is enabled, the port is shown as free, paths can be copied", async () => {
    await setup([status("php", [installed("8.4.26")]), status("mariadb", [installed("11.8.9")])]);
    render(<DatabaseSection />);

    expect(screen.getByRole("button", { name: "Start MariaDB" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Initialize Database" })).toBeDisabled();
    expect(await screen.findByText("Free")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3307")).toBeInTheDocument();
    expect(screen.getByText("C:/My Studio/data/mariadb")).toHaveAttribute(
      "title",
      "C:/My Studio/data/mariadb",
    );
  });

  it("a busy port blocks Start and says so", async () => {
    await setup([status("php", [installed("8.4.26")]), status("mariadb", [installed("11.8.9")])], {
      phpPortFree: vi.fn().mockResolvedValue(false),
    });
    render(<DatabaseSection />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start MariaDB" })).toBeDisabled();
    });
    expect(screen.getByText(/Busy — another program is using it/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start MariaDB" })).toHaveAttribute(
      "title",
      expect.stringContaining("Port 3307 is already in use"),
    );
  });

  it("Show Password fetches it only on request, Hide hides it, Copy uses the clipboard", async () => {
    const { ipc } = await setup(
      [status("php", [installed("8.4.26")]), status("mariadb", [installed("11.8.9")])],
      {
        mariadbCredentials: vi.fn().mockResolvedValue({ username: "root", password: "abc123XYZ" }),
      },
    );
    render(<DatabaseSection />);

    expect(ipc.mariadbCredentials).not.toHaveBeenCalled();
    expect(screen.queryByText("abc123XYZ")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show Password" }));
    expect(await screen.findByText("abc123XYZ")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide Password" }));
    expect(screen.queryByText("abc123XYZ")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy Password" }));
    await waitFor(() => {
      expect(ipc.clipboardWriteText).toHaveBeenCalledWith("abc123XYZ");
    });
    expect(screen.getByText(/stored encrypted for your Windows account/)).toBeInTheDocument();
  });

  it("a password that can't be decrypted is reported, not shown as 'no password'", async () => {
    const { events } = await setup(
      [status("php", [installed("8.4.26")]), status("mariadb", [installed("11.8.9")])],
      {
        mariadbCredentials: vi.fn().mockRejectedValue("Windows couldn't decrypt the stored value"),
      },
    );
    const errors: string[] = [];
    events.on("appError", (event) => errors.push(event.message));
    render(<DatabaseSection />);

    fireEvent.click(screen.getByRole("button", { name: "Copy Password" }));
    await waitFor(() => {
      expect(errors).toEqual(["Windows couldn't decrypt the stored value"]);
    });
  });
});

describe("phpMyAdmin and Composer sections", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("phpMyAdmin: not installed → Start disabled with its reason, Open needs a running server", async () => {
    await setup([status("php", [installed("8.4.26")])]);
    render(<PhpMyAdminSection />);

    expect(screen.getByRole("button", { name: "Start phpMyAdmin" })).toHaveAttribute(
      "title",
      "phpMyAdmin is not installed yet.",
    );
    expect(screen.getByRole("button", { name: "Open phpMyAdmin" })).toBeDisabled();
    expect(screen.getByDisplayValue("8081")).toBeInTheDocument();
  });

  it("Composer: no composer.json → every action is disabled with that reason", async () => {
    await setup([status("php", [installed("8.4.26")]), status("composer", [installed("2.10.3")])], {
      phpProjectInfo: vi.fn().mockResolvedValue({ isDir: true, hasComposerJson: false }),
    });
    const { composer } = harness.current as { composer: ComposerService };
    await composer.setProject("C:/My Site");
    render(<ComposerSection />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "composer install" })).toHaveAttribute(
        "title",
        "This folder has no composer.json.",
      );
    });
    for (const name of ["composer install", "composer update", "composer dump-autoload"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Stop Composer" })).toBeDisabled();
  });

  it("Composer: with a composer.json the actions run the matching command in the project root", async () => {
    const { ipc } = await setup(
      [status("php", [installed("8.4.26")]), status("composer", [installed("2.10.3")])],
      {
        phpProjectInfo: vi.fn().mockResolvedValue({ isDir: true, hasComposerJson: true }),
        composerRun: vi.fn().mockResolvedValue({ runId: "c1", file: "composer", pid: 5 }),
      },
    );
    vi.mocked(ipc.openFolderDialog).mockResolvedValue("C:/My Site");
    render(<ComposerSection />);
    expect(screen.getByRole("button", { name: "composer update" })).toHaveAttribute(
      "title",
      "Select a Composer project folder first.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Project…" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "composer update" })).toBeEnabled();
    });
    expect(ipc.settingsSet).toHaveBeenCalledWith("composer.project", "C:/My Site");
    fireEvent.click(screen.getByRole("button", { name: "composer update" }));
    await waitFor(() => {
      expect(ipc.composerRun).toHaveBeenCalledWith("update", "C:/My Site");
    });
  });
});

describe("Logs section and window command", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("tabs switch between the four service logs", async () => {
    const { output } = await setup([status("php", [installed("8.4.26")])]);
    output.append("PHP Server", "php line");
    output.append("MariaDB", "db line");
    render(<LogsSection />);

    const region = within(screen.getByRole("region", { name: "Logs" }));
    expect(region.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "PHP Server",
      "MariaDB",
      "phpMyAdmin",
      "Composer",
    ]);
    fireEvent.click(region.getByRole("tab", { name: "MariaDB" }));
    expect(region.getByText("db line")).toBeInTheDocument();
    expect(region.queryByText("php line")).toBeNull();
    fireEvent.click(region.getByRole("tab", { name: "Composer" }));
    expect(region.getByText("No Composer output yet.")).toBeInTheDocument();
    expect(region.getByRole("tab", { name: "Composer" })).toHaveAttribute("aria-selected", "true");
  });

  it("php.openWindow (the activity bar icon) asks the backend to open or focus the one window", async () => {
    const { php, ipc } = await setup([status("php", [installed("8.4.26")])]);
    const commands = new CommandRegistry();
    registerPhpCommands(commands, php, ipc);
    await commands.execute("php.openWindow");
    await commands.execute("php.openWindow");
    expect(ipc.phpWindowOpen).toHaveBeenCalledTimes(2);
  });
});
