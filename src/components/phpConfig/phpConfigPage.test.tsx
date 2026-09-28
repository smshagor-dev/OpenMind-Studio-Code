import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ComposerService } from "../../services/composerService";
import { EventBus } from "../../services/eventBus";
import type { AppEvents } from "../../services/events";
import type { InstalledVersion, RuntimeStatus } from "../../services/ipc";
import { MariaDbService } from "../../services/mariaDbService";
import { OutputService } from "../../services/outputService";
import { PanelService } from "../../services/panelService";
import { PhpMyAdminService } from "../../services/phpMyAdminService";
import { PhpRuntimeService } from "../../services/phpRuntimeService";
import { PhpServerService } from "../../services/phpServerService";
import { PortsService } from "../../services/portsService";
import { RuntimeService } from "../../services/runtimeService";
import { createFakeIpc } from "../../testUtils/fakeIpcClient";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { DatabaseSection, PhpMyAdminSection } from "../PhpStackSections";
import { ConfigChips, StackSummary } from "./ConfigHeader";
import { LaravelCard } from "./LaravelCard";

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

const ALL = [
  status("php", [installed("8.4.26")]),
  status("composer", [installed("2.10.3")]),
  status("mariadb", [installed("11.8.9")]),
  status("phpmyadmin", [installed("5.2.3")]),
];

async function setup(
  runtimes: RuntimeStatus[] = ALL,
  overrides: Parameters<typeof createFakeIpc>[0] = {},
) {
  const ipc = createFakeIpc({
    runtimeList: vi.fn().mockResolvedValue(runtimes),
    mariadbStatus: vi.fn().mockResolvedValue({
      initialized: true,
      running: null,
      dataDir: "C:/My Studio/data/mariadb",
      logDir: "C:/My Studio/logs/mariadb",
      configFile: "C:/My Studio/settings/mariadb/my.ini",
      hasPassword: true,
    }),
    mariadbCredentials: vi.fn().mockResolvedValue({ username: "root", password: "abc123XYZ" }),
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
  const phpRuntime = new PhpRuntimeService(runtime, php, { mariadb: mariaDb, pma: phpMyAdmin });
  harness.current = { php, mariaDb, phpMyAdmin, composer, runtime, output, ipc, phpRuntime };
  return { ipc, php, mariaDb, phpMyAdmin, composer, output };
}

beforeEach(() => {
  harness.current = null;
});

describe("Configuration page: MariaDB card and credentials", () => {
  it("shows host, port, user and a masked password — the real one is not fetched or shown", async () => {
    const { ipc } = await setup();
    render(<DatabaseSection />);
    const connection = within(screen.getByRole("group", { name: "Connection details" }));
    expect(connection.getByText("127.0.0.1")).toBeInTheDocument();
    expect(connection.getByText("3307")).toBeInTheDocument();
    expect(connection.getByText("root")).toBeInTheDocument();
    expect(connection.getByLabelText("Password hidden")).toHaveTextContent("••••••••");
    expect(screen.queryByText("abc123XYZ")).toBeNull();
    expect(ipc.mariadbCredentials).not.toHaveBeenCalled();
  });

  it("Reveal shows the password and Hide masks it again", async () => {
    await setup();
    render(<DatabaseSection />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal Password" }));
    expect(await screen.findByText("abc123XYZ")).toBeInTheDocument();
    expect(screen.queryByText("••••••••")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide Password" }));
    expect(screen.queryByText("abc123XYZ")).toBeNull();
    expect(screen.getByText("••••••••")).toBeInTheDocument();
  });

  it("Copy Password copies the password; Copy Connection String copies a string without one", async () => {
    const { ipc } = await setup();
    render(<DatabaseSection />);
    fireEvent.click(screen.getByRole("button", { name: "Copy Password" }));
    await waitFor(() => {
      expect(ipc.clipboardWriteText).toHaveBeenCalledWith("abc123XYZ");
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy Connection String" }));
    await waitFor(() => {
      expect(ipc.clipboardWriteText).toHaveBeenCalledWith("mysql://root@127.0.0.1:3307");
    });
    const copied = vi.mocked(ipc.clipboardWriteText).mock.calls.map((call) => call[0]);
    expect(copied.filter((text) => text.includes("abc123XYZ"))).toEqual(["abc123XYZ"]);
  });

  it("never writes the password to any output channel or the Extension-visible log", async () => {
    const { output } = await setup();
    render(<DatabaseSection />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal Password" }));
    await screen.findByText("abc123XYZ");
    fireEvent.click(screen.getByRole("button", { name: "Copy Password" }));
    const channels = ["OpenMind Studio", "MariaDB", "PHP Server", "phpMyAdmin", "Composer"];
    for (const channel of channels) {
      expect(output.getLines(channel).join("\n")).not.toContain("abc123XYZ");
    }
  });

  it("with no password yet, reveal and copy are disabled with the reason", async () => {
    await setup(ALL, {
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
    const reveal = screen.getByRole("button", { name: "Reveal Password" });
    expect(reveal).toBeDisabled();
    expect(reveal).toHaveAttribute("title", expect.stringContaining("initialize the database"));
    expect(screen.getByText("Not set yet")).toBeInTheDocument();
  });

  it("shows the bind address, data, config and log locations", async () => {
    await setup();
    render(<DatabaseSection />);
    expect(screen.getByText("127.0.0.1 (this computer only)")).toBeInTheDocument();
    expect(screen.getByText("C:/My Studio/data/mariadb")).toBeInTheDocument();
    expect(screen.getByText("C:/My Studio/settings/mariadb/my.ini")).toBeInTheDocument();
    expect(screen.getByText("C:/My Studio/logs/mariadb")).toBeInTheDocument();
    expect(screen.getByText("MariaDB: Stopped")).toBeInTheDocument();
  });

  it("MariaDB missing: every credential button that can't work says why", async () => {
    await setup([status("php", [installed("8.4.26")])], {
      mariadbStatus: vi.fn().mockResolvedValue({
        initialized: false,
        running: null,
        dataDir: "",
        logDir: "",
        configFile: "",
        hasPassword: false,
      }),
    });
    render(<DatabaseSection />);
    expect(screen.getByText("MariaDB: Not installed")).toBeInTheDocument();
    const copy = screen.getByRole("button", { name: "Copy Connection String" });
    expect(copy).toBeDisabled();
    expect(copy).toHaveAttribute("title", "Install MariaDB first.");
  });
});

describe("Configuration page: phpMyAdmin card", () => {
  it("Admin (Open phpMyAdmin) is disabled with the reason while phpMyAdmin is not running", async () => {
    await setup();
    render(<PhpMyAdminSection />);
    const open = screen.getByRole("button", { name: "Open phpMyAdmin" });
    expect(open).toBeDisabled();
    expect(screen.getByText("phpMyAdmin: Available")).toBeInTheDocument();
    expect(screen.getByText("None until it runs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy phpMyAdmin URL" })).toBeDisabled();
  });

  it("missing phpMyAdmin: says so and offers no working Admin", async () => {
    await setup([status("php", [installed("8.4.26")])]);
    render(<PhpMyAdminSection />);
    expect(screen.getByText("phpMyAdmin: Not installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open phpMyAdmin" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start phpMyAdmin" })).toHaveAttribute(
      "title",
      "phpMyAdmin is not installed yet.",
    );
  });

  it("running phpMyAdmin with MariaDB running: Admin opens the address and the URL can be copied", async () => {
    const { ipc, phpMyAdmin, mariaDb } = await setup(ALL, {
      openExternalUrl: vi.fn().mockResolvedValue(undefined),
    });
    // The services hold the running state; set it the way the backend events do.
    vi.spyOn(mariaDb, "status").mockReturnValue("running");
    vi.spyOn(phpMyAdmin, "getState").mockReturnValue({
      ...phpMyAdmin.getState(),
      server: { runId: "p1", pid: 7, port: 8081, url: "http://127.0.0.1:8081", version: "5.2.3" },
    } as never);
    vi.spyOn(phpMyAdmin, "openState").mockReturnValue({ enabled: true });
    render(<PhpMyAdminSection />);
    expect(screen.getByText("phpMyAdmin: Running")).toBeInTheDocument();
    const open = screen.getByRole("button", { name: "Open phpMyAdmin" });
    expect(open).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Copy phpMyAdmin URL" }));
    expect(ipc.clipboardWriteText).toHaveBeenCalledWith("http://127.0.0.1:8081");
  });

  it("running phpMyAdmin but MariaDB stopped: Admin says Start MariaDB first", async () => {
    const { phpMyAdmin } = await setup();
    vi.spyOn(phpMyAdmin, "getState").mockReturnValue({
      ...phpMyAdmin.getState(),
      server: { runId: "p1", pid: 7, port: 8081, url: "http://127.0.0.1:8081", version: "5.2.3" },
    } as never);
    vi.spyOn(phpMyAdmin, "openState").mockReturnValue({ enabled: true });
    render(<PhpMyAdminSection />);
    const open = screen.getByRole("button", { name: "Open phpMyAdmin" });
    expect(open).toBeDisabled();
    expect(open).toHaveAttribute("title", "Start MariaDB first.");
    expect(screen.getByText("Admin: Start MariaDB first.")).toBeInTheDocument();
  });
});

describe("Configuration page: header, summary and Laravel helper", () => {
  it("shows a chip per part of the stack with the real status", async () => {
    await setup();
    render(<ConfigChips />);
    const chips = within(screen.getByRole("list", { name: "Stack status" }));
    expect(chips.getByText("PHP: Active 8.4.26")).toBeInTheDocument();
    expect(chips.getByText("Composer: 2.10.3")).toBeInTheDocument();
    expect(chips.getByText("MariaDB: Stopped")).toBeInTheDocument();
    expect(chips.getByText("phpMyAdmin: Available")).toBeInTheDocument();
  });

  it("the summary lists versions, statuses and addresses without fabricating any", async () => {
    await setup([status("php", [installed("8.4.26")])]);
    render(<StackSummary />);
    const card = within(screen.getByRole("region", { name: "Stack Summary" }));
    expect(card.getByText("8.4.26")).toBeInTheDocument();
    expect(card.getAllByText("Not installed").length).toBeGreaterThanOrEqual(3);
    expect(card.getByText("Stopped")).toBeInTheDocument();
    expect(card.getByText("None until it runs")).toBeInTheDocument();
  });

  it("Laravel helper: absent for an ordinary project", async () => {
    const { composer } = await setup(ALL, {
      phpProjectInfo: vi
        .fn()
        .mockResolvedValue({ isDir: true, hasComposerJson: true, isLaravel: false }),
    });
    await composer.setProject("C:/My Site");
    render(<LaravelCard />);
    expect(screen.queryByRole("region", { name: "Laravel" })).toBeNull();
  });

  it("Laravel helper: shows the stack, copies DB credentials for .env and never edits the .env", async () => {
    const { ipc, composer } = await setup(ALL, {
      phpProjectInfo: vi.fn().mockResolvedValue({
        isDir: true,
        hasComposerJson: true,
        isLaravel: true,
        hasVendor: false,
        hasEnv: false,
        npmScripts: ["dev", "build"],
      }),
    });
    await composer.setProject("C:/My Laravel Site");
    render(<LaravelCard />);
    const card = within(await screen.findByRole("region", { name: "Laravel" }));
    expect(card.getByText("8.4.26")).toBeInTheDocument();
    expect(card.getByText("2.10.3")).toBeInTheDocument();
    expect(card.getByText("Not found — copy .env.example")).toBeInTheDocument();
    for (const command of [
      "composer install",
      "php artisan serve",
      "npm run dev",
      "npm run build",
    ]) {
      expect(card.getByText(command)).toBeInTheDocument();
    }
    fireEvent.click(card.getByRole("button", { name: "Copy php artisan serve" }));
    expect(ipc.clipboardWriteText).toHaveBeenCalledWith("php artisan serve");
    fireEvent.click(card.getByRole("button", { name: "Copy DB Credentials for .env" }));
    await waitFor(() => {
      expect(ipc.clipboardWriteText).toHaveBeenCalledWith(
        "DB_CONNECTION=mariadb\nDB_HOST=127.0.0.1\nDB_PORT=3307\nDB_DATABASE=\nDB_USERNAME=root\nDB_PASSWORD=abc123XYZ",
      );
    });
    // Copy only: no file is written.
    expect(card.getByText(/never edits or overwrites your \.env/)).toBeInTheDocument();
    expect(ipc.fsCreateFile).not.toHaveBeenCalled();
    expect(ipc.documentSave).not.toHaveBeenCalled();
  });
});
