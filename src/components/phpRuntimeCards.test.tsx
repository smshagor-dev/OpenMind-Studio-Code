import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { FeatureStatus, InstalledVersion, RuntimeStatus } from "../services/ipc";
import { OutputService } from "../services/outputService";
import { PanelService } from "../services/panelService";
import { PhpRuntimeService } from "../services/phpRuntimeService";
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

import { PhpRuntimeCards } from "./PhpRuntimeCards";

const PHP_VERSIONS = ["8.4.26", "8.3.35", "8.2.34", "8.1.34", "8.0.30"];

function feature(id: string, label: string, available = true): FeatureStatus {
  return { id, label, available, note: available ? "" : `${label} is missing` };
}

function install(
  version: string,
  over: Partial<InstalledVersion> = {},
  features: FeatureStatus[] = [],
): InstalledVersion {
  return { version, path: "C:/x", active: false, healthy: true, features, ...over };
}

function status(
  id: string,
  installed: InstalledVersion[],
  over: Partial<RuntimeStatus> = {},
): RuntimeStatus {
  return {
    id,
    displayName: id,
    description: `${id} description`,
    notes: "",
    defaultVersion: "1.0.0",
    availableVersions: installed.map((entry) => entry.version),
    installed,
    activeVersion: installed.find((entry) => entry.active)?.version ?? null,
    globalVersion: null,
    busy: false,
    ...over,
  };
}

const PHP = (installed: InstalledVersion[]) =>
  status("php", installed, { availableVersions: PHP_VERSIONS, defaultVersion: "8.4.26" });

async function setup(runtimes: RuntimeStatus[]) {
  const ipc = createFakeIpc({
    runtimeList: vi.fn().mockResolvedValue(runtimes),
    workspaceActiveFolder: vi
      .fn()
      .mockResolvedValue({ id: 1, path: "C:/My Site", name: "My Site" }),
  });
  const events = new EventBus<AppEvents>();
  const runtime = new RuntimeService(ipc, events, () => undefined);
  await runtime.refresh();
  const php = new PhpServerService(
    ipc,
    events,
    new OutputService(),
    runtime,
    new PortsService(ipc, events),
    new PanelService(ipc),
  );
  await php.initialize();
  harness.current = { runtime, php, phpRuntime: new PhpRuntimeService(runtime, php) };
  return { runtime, php, ipc };
}

const card = (name: string) => screen.getByRole("article", { name });

describe("PhpRuntimeCards", () => {
  beforeEach(() => {
    harness.current = null;
  });

  it("shows a PHP and a Composer card with their state", async () => {
    await setup([
      PHP([
        install("8.4.26", { active: true }, [
          feature("cli", "PHP CLI"),
          feature("ini", "php.ini (OpenMind)", false),
        ]),
      ]),
      status("composer", []),
    ]);
    render(<PhpRuntimeCards />);

    const php = within(card("PHP"));
    expect(php.getByText("Installed", { selector: ".ext-view__badge" })).toBeInTheDocument();
    expect(php.getByText("Installed — active 8.4.26")).toBeInTheDocument();
    expect(php.getByText("OpenMind portable")).toBeInTheDocument();
    expect(php.getByText("In new terminals' PATH")).toBeInTheDocument();
    expect(php.getByText("✓ PHP CLI")).toBeInTheDocument();
    expect(php.getByText("✗ php.ini (OpenMind)")).toBeInTheDocument();

    const composer = within(card("Composer"));
    expect(
      composer.getByText("Not installed", { selector: ".ext-view__badge" }),
    ).toBeInTheDocument();
    expect(composer.getByText("✗ Composer PHAR")).toBeInTheDocument();
  });

  it("the PHP card lists 8.0 to 8.4 with 8.4 marked recommended and an Install button each", async () => {
    await setup([PHP([])]);
    render(<PhpRuntimeCards />);

    const php = within(card("PHP"));
    for (const version of PHP_VERSIONS) {
      expect(php.getByRole("button", { name: `Install PHP ${version}` })).toBeEnabled();
    }
    expect(php.getAllByText("recommended")).toHaveLength(1);
    const recommended = within(php.getByText("recommended").closest("li") as HTMLElement);
    expect(recommended.getByText("8.4.26")).toBeInTheDocument();
  });

  it("installed PHP versions show active/installed with Set Active, Repair and Delete states", async () => {
    await setup([PHP([install("8.4.26", { active: true }), install("8.3.35")])]);
    render(<PhpRuntimeCards />);

    const php = within(card("PHP"));
    expect(php.getByText("active")).toBeInTheDocument();
    expect(php.getByRole("button", { name: "Set PHP 8.4.26 Active" })).toBeDisabled();
    expect(php.getByRole("button", { name: "Set PHP 8.3.35 Active" })).toBeEnabled();
    expect(php.getByRole("button", { name: "Delete PHP 8.3.35" })).toBeEnabled();
    expect(php.getByRole("button", { name: "Repair PHP 8.3.35" })).toBeDisabled();
    expect(php.queryByRole("button", { name: "Install PHP 8.4.26" })).toBeNull();
  });

  it("Set Active asks the runtime manager to switch", async () => {
    const { runtime } = await setup([
      PHP([install("8.4.26", { active: true }), install("8.3.35")]),
    ]);
    const setActive = vi.spyOn(runtime, "setActive").mockResolvedValue(true);
    render(<PhpRuntimeCards />);

    fireEvent.click(within(card("PHP")).getByRole("button", { name: "Set PHP 8.3.35 Active" }));

    expect(setActive).toHaveBeenCalledWith("php", "8.3.35");
  });

  it("Composer's card shows its PHP dependency, and its install is disabled with a visible reason without PHP", async () => {
    await setup([status("composer", [], { availableVersions: ["2.10.3"] })]);
    render(<PhpRuntimeCards />);

    const composer = within(card("Composer"));
    expect(
      composer.getByText(/PHP isn't installed — Composer needs OpenMind's portable PHP/),
    ).toBeInTheDocument();
    const button = composer.getByRole("button", { name: "Install Composer 2.10.3" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Install PHP first — Composer runs on it.");
    expect(
      composer.getByText("Install PHP first — Composer runs on it.", {
        selector: ".ext-view__reason",
      }),
    ).toBeInTheDocument();
  });

  it("Composer with PHP active shows it runs on that PHP", async () => {
    await setup([
      PHP([install("8.3.35", { active: true })]),
      status("composer", [install("2.10.3", { active: true }, [feature("phar", "Composer PHAR")])]),
    ]);
    render(<PhpRuntimeCards />);

    expect(within(card("Composer")).getByText(/Runs on the active PHP 8.3.35/)).toBeInTheDocument();
  });

  it("with Composer installed but no PHP active the card warns instead", async () => {
    await setup([
      PHP([install("8.4.26")]),
      status("composer", [install("2.10.3", { active: true })]),
    ]);
    render(<PhpRuntimeCards />);

    expect(
      within(card("Composer")).getByText(/No PHP is active — Composer can't run/),
    ).toBeInTheDocument();
  });

  it("a version deletion refused because the server runs on it prints the reason", async () => {
    const { php, ipc } = await setup([PHP([install("8.4.26", { active: true })])]);
    vi.mocked(ipc.phpServerStart).mockResolvedValue({
      run: { runId: "php-1", file: "", pid: 1 },
      url: "http://127.0.0.1:8000",
      port: 8000,
      phpVersion: "8.4.26",
    });
    await php.useWorkspace();
    await php.start();
    render(<PhpRuntimeCards />);

    const php_ = within(card("PHP"));
    expect(php_.getByRole("button", { name: "Delete PHP 8.4.26" })).toBeDisabled();
    expect(
      php_.getByText("The PHP server is running on PHP 8.4.26. Stop the server first."),
    ).toBeInTheDocument();
  });
});
