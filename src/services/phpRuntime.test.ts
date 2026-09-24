import { describe, expect, it, vi } from "vitest";

import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { FeatureStatus, InstalledVersion, IpcClient, RunEvent, RuntimeStatus } from "./ipc";
import { OutputService } from "./outputService";
import { PanelService } from "./panelService";
import { PhpRuntimeService } from "./phpRuntimeService";
import { PhpServerService } from "./phpServerService";
import { PortsService } from "./portsService";
import { RuntimeService } from "./runtimeService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

const PHP_VERSIONS = ["8.4.26", "8.3.35", "8.2.34", "8.1.34", "8.0.30"];

function feature(id: string, label: string, available = true): FeatureStatus {
  return { id, label, available, note: available ? "" : `${label} is missing` };
}

function install(
  version: string,
  over: Partial<InstalledVersion> = {},
  features: FeatureStatus[] = [],
): InstalledVersion {
  return {
    version,
    path: `C:/app/runtimes/x/versions/${version}`,
    active: false,
    healthy: true,
    features,
    ...over,
  };
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

function phpStatus(installed: InstalledVersion[]): RuntimeStatus {
  return status("php", installed, { availableVersions: PHP_VERSIONS, defaultVersion: "8.4.26" });
}

interface Rig {
  cards: PhpRuntimeService;
  php: PhpServerService;
  runtime: RuntimeService;
  ipc: IpcClient;
  emit: (event: RunEvent) => void;
  setRuntimes: (runtimes: RuntimeStatus[]) => Promise<void>;
}

async function rig(runtimes: RuntimeStatus[]): Promise<Rig> {
  let handler: (event: RunEvent) => void = () => undefined;
  const list = vi.fn().mockResolvedValue(runtimes);
  const ipc = createFakeIpc({
    runtimeList: list,
    workspaceActiveFolder: vi
      .fn()
      .mockResolvedValue({ id: 1, path: "C:/My Site", name: "My Site" }),
    onPhpEvent: vi.fn((h: typeof handler) => {
      handler = h;
      return Promise.resolve(() => undefined);
    }),
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
  return {
    cards: new PhpRuntimeService(runtime, php),
    php,
    runtime,
    ipc,
    emit: (event) => {
      handler(event);
    },
    setRuntimes: async (next) => {
      list.mockResolvedValue(next);
      await runtime.refresh();
    },
  };
}

describe("PhpRuntimeService cards", () => {
  it("has a PHP and a Composer card, even before anything is loaded", async () => {
    const r = await rig([]);

    expect(r.cards.cards().map((card) => card.name)).toEqual([
      "PHP",
      "Composer",
      "MariaDB",
      "phpMyAdmin",
    ]);
    for (const card of r.cards.cards()) {
      expect(card).toMatchObject({
        installed: false,
        activeVersion: null,
        source: "none",
        sourceLabel: "Not installed",
      });
      expect(card.terminal).toEqual({ injected: false, label: "Not active" });
    }
  });

  it("lists each runtime's features even before it is installed, as not available", async () => {
    const r = await rig([]);

    expect(r.cards.card("php").features.map((f) => f.label)).toEqual([
      "PHP CLI",
      "Built-in server (php -S)",
      "php.ini (OpenMind)",
    ]);
    expect(r.cards.card("composer").features.map((f) => f.label)).toEqual(["Composer PHAR"]);
    expect(r.cards.card("php").features.every((f) => !f.available)).toBe(true);
  });

  it("an installed active PHP shows its real feature status and terminal PATH state", async () => {
    const r = await rig([
      phpStatus([
        install("8.4.26", { active: true }, [
          feature("cli", "PHP CLI"),
          feature("server", "Built-in server (php -S)"),
          feature("ini", "php.ini (OpenMind)", false),
        ]),
      ]),
    ]);

    const card = r.cards.card("php");

    expect(card).toMatchObject({
      installed: true,
      activeVersion: "8.4.26",
      source: "portable",
      sourceLabel: "OpenMind portable",
    });
    expect(card.terminal).toEqual({ injected: true, label: "In new terminals' PATH" });
    expect(card.features).toEqual([
      { label: "PHP CLI", available: true, note: "" },
      { label: "Built-in server (php -S)", available: true, note: "" },
      { label: "php.ini (OpenMind)", available: false, note: "php.ini (OpenMind) is missing" },
    ]);
  });

  it("a PHP found only on the system is labelled, and OpenMind says it never uses it", async () => {
    const r = await rig([
      status("php", [], { globalVersion: "8.2.12", availableVersions: PHP_VERSIONS }),
    ]);

    expect(r.cards.card("php")).toMatchObject({ source: "system", installed: false });
    expect(r.cards.card("php").sourceLabel).toBe(
      "System detected (8.2.12) — OpenMind never uses it",
    );
  });

  it("an installed version that isn't active shows 'not active in new terminals'", async () => {
    const r = await rig([phpStatus([install("8.3.35")])]);

    expect(r.cards.card("php")).toMatchObject({ installed: true, activeVersion: null });
    expect(r.cards.card("php").terminal.label).toContain("Not active in new terminals");
  });
});

describe("PHP version matrix", () => {
  it("offers PHP 8.0 through 8.4, newest first, with 8.4 recommended", async () => {
    const r = await rig([phpStatus([])]);

    const available = r.cards.card("php").availableVersions;

    expect(available.map((v) => v.version)).toEqual(PHP_VERSIONS);
    expect(available.filter((v) => v.recommended).map((v) => v.version)).toEqual(["8.4.26"]);
    expect(available.every((v) => v.install.enabled)).toBe(true);
  });

  it("splits installed (newest first) from available, and each row has the right actions enabled", async () => {
    const r = await rig([phpStatus([install("8.4.26", { active: true }), install("8.3.35")])]);

    const card = r.cards.card("php");

    expect(card.installedVersions.map((v) => [v.version, v.active])).toEqual([
      ["8.4.26", true],
      ["8.3.35", false],
    ]);
    expect(card.availableVersions.map((v) => v.version)).toEqual(["8.2.34", "8.1.34", "8.0.30"]);
    const [active, other] = card.installedVersions;
    expect(active?.setActive).toEqual({
      enabled: false,
      reason: "This is already the active version.",
    });
    expect(other?.setActive).toEqual({ enabled: true });
    expect(other?.remove).toEqual({ enabled: true });
    expect(other?.repair.enabled).toBe(false);
    expect(other?.repair.reason).toContain("intact");
  });

  it("a damaged version can be repaired but not made active", async () => {
    const r = await rig([
      phpStatus([install("8.4.26", { active: true }), install("8.2.34", { healthy: false })]),
    ]);

    const broken = r.cards.card("php").installedVersions.find((v) => v.version === "8.2.34");

    expect(broken?.repair).toEqual({ enabled: true });
    expect(broken?.setActive.enabled).toBe(false);
    expect(broken?.setActive.reason).toContain("Repair");
  });

  it("actions go through the Runtime Manager with the chosen version", async () => {
    const r = await rig([phpStatus([install("8.4.26", { active: true })])]);
    const installSpy = vi.spyOn(r.runtime, "install").mockResolvedValue(true);
    const activeSpy = vi.spyOn(r.runtime, "setActive").mockResolvedValue(true);
    const repairSpy = vi.spyOn(r.runtime, "repair").mockResolvedValue(true);
    const removeSpy = vi.spyOn(r.runtime, "remove").mockResolvedValue(true);

    await r.cards.install("php", "8.3.35");
    await r.cards.setActive("php", "8.3.35");
    await r.cards.repair("php", "8.4.26");
    await r.cards.remove("php", "8.4.26");

    expect(installSpy).toHaveBeenCalledWith("php", "8.3.35");
    expect(activeSpy).toHaveBeenCalledWith("php", "8.3.35");
    expect(repairSpy).toHaveBeenCalledWith("php", "8.4.26");
    expect(removeSpy).toHaveBeenCalledWith("php", "8.4.26");
  });

  it("while a PHP operation runs every PHP action is disabled with a reason", async () => {
    const r = await rig([phpStatus([install("8.4.26", { active: true })])]);
    let release: () => void = () => undefined;
    vi.mocked(r.ipc.runtimeInstall).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({} as never);
          };
        }),
    );

    const pending = r.runtime.install("php", "8.3.35");
    const card = r.cards.card("php");

    expect(card.working).toBe(true);
    expect(card.availableVersions[0]?.install.reason).toContain("being changed");
    expect(card.installedVersions[0]?.remove.enabled).toBe(false);
    release();
    await pending;
  });

  it("another PHP line is never called an update", async () => {
    const r = await rig([phpStatus([install("8.3.35", { active: true })])]);

    expect(r.cards.card("php").update).toBeNull();
  });
});

describe("Composer and PHP", () => {
  it("Composer can't be installed without PHP, and says so", async () => {
    const r = await rig([status("composer", [], { availableVersions: ["2.10.3"] })]);

    const version = r.cards.card("composer").availableVersions[0];

    expect(version?.install).toEqual({
      enabled: false,
      reason: "Install PHP first — Composer runs on it.",
    });
    expect(r.cards.composerDependency()).toEqual({
      ok: false,
      label: "PHP isn't installed — Composer needs OpenMind's portable PHP.",
    });
  });

  it("Composer can be installed once any PHP is installed", async () => {
    const r = await rig([
      phpStatus([install("8.4.26", { active: true })]),
      status("composer", [], { availableVersions: ["2.10.3"] }),
    ]);

    expect(r.cards.card("composer").availableVersions[0]?.install).toEqual({ enabled: true });
    expect(r.cards.composerDependency()).toEqual({
      ok: true,
      label: "Runs on the active PHP 8.4.26",
    });
  });

  it("with Composer installed but no PHP active, its card warns and the dependency is not ok", async () => {
    const r = await rig([
      phpStatus([install("8.4.26")]),
      status("composer", [install("2.10.3", { active: true })]),
    ]);

    expect(r.cards.composerDependency()).toMatchObject({ ok: false });
    expect(r.cards.composerDependency().label).toContain("Set a PHP version active");
    expect(r.cards.card("composer").notice).toContain("No PHP is active");
  });

  it("Composer's notice disappears when PHP is active again", async () => {
    const r = await rig([
      phpStatus([install("8.4.26")]),
      status("composer", [install("2.10.3", { active: true })]),
    ]);
    await r.setRuntimes([
      phpStatus([install("8.4.26", { active: true })]),
      status("composer", [install("2.10.3", { active: true })]),
    ]);

    expect(r.cards.card("composer").notice).toBeNull();
  });

  it("offers a Composer update in its own line only, without switching anything", async () => {
    const r = await rig([
      status("composer", [install("2.9.1", { active: true })], {
        availableVersions: ["2.10.3", "2.9.1", "1.10.28"],
      }),
      phpStatus([install("8.4.26", { active: true })]),
    ]);

    const card = r.cards.card("composer");

    expect(card.update).toEqual({ version: "2.10.3", availability: { enabled: true } });
    const spy = vi.spyOn(r.runtime, "install").mockResolvedValue(true);
    await r.cards.install("composer", card.update?.version ?? "");
    expect(spy).toHaveBeenCalledWith("composer", "2.10.3");
  });

  it("a running PHP server blocks deleting or repairing the PHP it uses, and a switch shows the restart notice", async () => {
    const r = await rig([
      phpStatus([install("8.4.26", { active: true }), install("8.3.35", { healthy: false })]),
    ]);
    vi.mocked(r.ipc.phpServerStart).mockResolvedValue({
      run: { runId: "php-1", file: "", pid: 1 },
      url: "http://127.0.0.1:8000",
      port: 8000,
      phpVersion: "8.4.26",
    });
    await r.php.useWorkspace();
    await r.php.start();

    const rows = r.cards.card("php").installedVersions;
    const inUse = rows.find((v) => v.version === "8.4.26");
    const other = rows.find((v) => v.version === "8.3.35");
    expect(inUse?.remove).toEqual({
      enabled: false,
      reason: "The PHP server is running on PHP 8.4.26. Stop the server first.",
    });
    expect(inUse?.repair.enabled).toBe(false);
    expect(other?.remove.enabled).toBe(true);
    expect(other?.repair.enabled).toBe(true);
    expect(r.cards.card("php").notice).toBeNull();

    await r.setRuntimes([phpStatus([install("8.4.26"), install("8.3.35", { active: true })])]);

    expect(r.cards.card("php").notice).toContain(
      "Restart the PHP server to use the new PHP version.",
    );
    // The old PHP is still the one running, so it is still protected.
    expect(
      r.cards.card("php").installedVersions.find((v) => v.version === "8.4.26")?.remove.enabled,
    ).toBe(false);

    // Stopping the server clears the notice and the protection.
    r.emit({ runId: "php-1", type: "exited", code: null, durationMs: 1, stopped: true });
    expect(r.cards.card("php").notice).toBeNull();
    expect(
      r.cards.card("php").installedVersions.find((v) => v.version === "8.4.26")?.remove.enabled,
    ).toBe(true);
  });
});
