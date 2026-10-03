import { connectBackend } from "../testUtils/canonicalFeeds";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../services/commandRegistry";
import { ComposerService } from "../services/composerService";
import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { InstalledVersion, RuntimeStatus } from "../services/ipc";
import { MariaDbService } from "../services/mariaDbService";
import { MySqlService } from "../services/mySqlService";
import { OutputService } from "../services/outputService";
import { PanelService } from "../services/panelService";
import { registerPhpCommands } from "../services/phpCommands";
import { PhpMyAdminService } from "../services/phpMyAdminService";
import { PhpServerService } from "../services/phpServerService";
import { PortsService } from "../services/portsService";
import { RuntimeService } from "../services/runtimeService";
import { createFakeIpc, STOPPED_MYSQL } from "../testUtils/fakeIpcClient";

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
    requires: [],
    license: null,
    downloadBytes: null,
    installBytes: null,
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
  const feeds = connectBackend(ipc, { runtime, ports });
  await runtime.refresh();
  const panel = new PanelService(ipc);
  const php = new PhpServerService(ipc, events, output, runtime, panel);
  php.useCanonical(feeds.servers);
  await php.initialize();
  const mariaDb = new MariaDbService(ipc, events, output, runtime, panel);
  mariaDb.useCanonical(feeds.servers);
  await mariaDb.initialize();
  const phpMyAdmin = new PhpMyAdminService(
    ipc,
    events,
    output,
    runtime,
    panel,
    php,
    mariaDb,
  );
  phpMyAdmin.useCanonical(feeds.servers);
  await phpMyAdmin.initialize();
  const composer = new ComposerService(ipc, events, output, runtime, panel);
  await composer.initialize();
  const mySql = new MySqlService(ipc, events, output);
  mySql.useCanonical(feeds.servers);
  await mySql.initialize();
  harness.current = { php, mariaDb, phpMyAdmin, composer, mySql, runtime, output, ipc };
  return { ipc, php, mariaDb, mySql, output, events };
}

const NOTHING_INSTALLED = {
  ...STOPPED_MYSQL,
  state: "notInstalled" as const,
  missing: ["MariaDB", "phpMyAdmin"],
  initialized: false,
  mariadbVersion: null,
  phpmyadminVersion: null,
};

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
      mysqlStatus: vi.fn().mockResolvedValue(NOTHING_INSTALLED),
    });
    render(<DatabaseSection />);

    expect(screen.getAllByText("Not installed")).toHaveLength(2); // status and version
    const start = screen.getByRole("button", { name: "Start MySQL" });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute(
      "title",
      "Not installed yet: MariaDB, phpMyAdmin. Install it with Config > Install.",
    );
    expect(screen.getByRole("button", { name: "Stop MySQL" })).toHaveAttribute(
      "title",
      "MySQL isn't running.",
    );
    expect(screen.getByRole("button", { name: "Reveal Password" })).toBeDisabled();
  });

  it("installed: one MySQL Start, no separate Initialize / Start MariaDB, port and paths shown", async () => {
    await setup([status("php", [installed("8.4.26")]), status("mariadb", [installed("11.8.9")])]);
    render(<DatabaseSection />);

    expect(screen.getByRole("button", { name: "Start MySQL" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Initialize Database" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start MariaDB" })).toBeNull();
    expect(screen.getByText(/MariaDB starts and stops with MySQL/)).toBeInTheDocument();
    expect(await screen.findByText("Free")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3306")).toBeInTheDocument();
    expect(screen.getByText("C:/My Studio/data/mariadb")).toHaveAttribute(
      "title",
      "C:/My Studio/data/mariadb",
    );
  });

  it("a busy default port is shown, and Start stays available (MySQL falls back to another port)", async () => {
    await setup([status("php", [installed("8.4.26")]), status("mariadb", [installed("11.8.9")])], {
      phpPortFree: vi.fn().mockResolvedValue(false),
    });
    render(<DatabaseSection />);

    expect(await screen.findByText(/Busy — another program is using it/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start MySQL" })).toBeEnabled();
  });

  it("Start MySQL, Stop MySQL and Restart MySQL each call one backend command", async () => {
    const running = {
      ...STOPPED_MYSQL,
      state: "running" as const,
      mariadb: { run: { runId: "m", file: "", pid: 1 }, port: 3306, url: null, ready: true, version: null, phpVersion: null },
      phpmyadmin: { run: { runId: "p", file: "", pid: 2 }, port: 8081, url: "http://127.0.0.1:8081", ready: true, version: null, phpVersion: null },
    };
    const { ipc } = await setup(
      [status("php", [installed("8.4.26")]), status("mariadb", [installed("11.8.9")])],
      {
        mysqlStart: vi.fn().mockResolvedValue(running),
        mysqlRestart: vi.fn().mockResolvedValue(running),
        mysqlStop: vi.fn().mockResolvedValue(STOPPED_MYSQL),
      },
    );
    render(<DatabaseSection />);
    fireEvent.click(screen.getByRole("button", { name: "Start MySQL" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop MySQL" })).toBeEnabled();
    });
    expect(ipc.mysqlStart).toHaveBeenCalledTimes(1);
    expect(ipc.mariadbInitialize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restart MySQL" }));
    await waitFor(() => {
      expect(ipc.mysqlRestart).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop MySQL" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop MySQL" }));
    await waitFor(() => {
      expect(ipc.mysqlStop).toHaveBeenCalledTimes(1);
    });
  });

  it("Reveal Password fetches it only on request, Hide hides it, Copy uses the clipboard", async () => {
    const { ipc } = await setup(
      [status("php", [installed("8.4.26")]), status("mariadb", [installed("11.8.9")])],
      {
        mariadbCredentials: vi.fn().mockResolvedValue({ username: "root", password: "abc123XYZ" }),
      },
    );
    render(<DatabaseSection />);

    expect(ipc.mariadbCredentials).not.toHaveBeenCalled();
    expect(screen.queryByText("abc123XYZ")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal Password" }));
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

  it("phpMyAdmin: no Start/Stop of its own; Open phpMyAdmin says what is missing", async () => {
    await setup([status("php", [installed("8.4.26")])], {
      mysqlStatus: vi.fn().mockResolvedValue(NOTHING_INSTALLED),
    });
    render(<PhpMyAdminSection />);

    expect(screen.queryByRole("button", { name: "Start phpMyAdmin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop phpMyAdmin" })).toBeNull();
    const open = screen.getByRole("button", { name: "Open phpMyAdmin" });
    expect(open).toBeDisabled();
    expect(open).toHaveAttribute("title", expect.stringContaining("Not installed yet"));
    expect(screen.getByText(/phpMyAdmin starts and stops with MySQL/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("8081")).toBeInTheDocument();
  });

  it("Open phpMyAdmin starts MySQL first when it is stopped, then opens its address", async () => {
    const running = {
      ...STOPPED_MYSQL,
      state: "running" as const,
      mariadb: { run: { runId: "m", file: "", pid: 1 }, port: 3306, url: null, ready: true, version: null, phpVersion: null },
      phpmyadmin: { run: { runId: "p", file: "", pid: 2 }, port: 8082, url: "http://127.0.0.1:8082", ready: true, version: null, phpVersion: null },
    };
    const { ipc } = await setup(
      [status("php", [installed("8.4.26")]), status("mariadb", [installed("11.8.9")]), status("phpmyadmin", [installed("5.2.3")])],
      { mysqlStart: vi.fn().mockResolvedValue(running) },
    );
    render(<PhpMyAdminSection />);
    fireEvent.click(screen.getByRole("button", { name: "Open phpMyAdmin" }));
    await waitFor(() => {
      expect(ipc.openExternalUrl).toHaveBeenCalledWith("http://127.0.0.1:8082");
    });
    expect(ipc.mysqlStart).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/signs in by itself as root/)).toBeInTheDocument();
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
