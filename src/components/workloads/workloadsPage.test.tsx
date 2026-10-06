import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { i18n } from "../../i18n";
import { EventBus } from "../../services/eventBus";
import type { AppEvents } from "../../services/events";
import { CATALOG } from "../../services/workloads/workloadModel.test";
import type { Plan, WorkloadsIpc } from "../../services/workloads/workloadsIpc";
import type { WorkloadCatalog } from "../../services/workloads/workloadsIpc";
import { WorkloadService } from "../../services/workloads/workloadService";
import { wireWorkloads } from "../../services/workloads/workloadsWiring";
import { CommandRegistry } from "../../services/commandRegistry";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { FirstRunWorkloads, WorkloadsPage } from "./WorkloadsPage";
import { preloadLanguages } from "../../testUtils/languages";

preloadLanguages("ru");

const NETWORK_STATE = { status: null, offline: [], staleTerminals: [] };
const RUNTIME_STATE = {
  runtimes: [{ id: "android-cmdline-tools", license: { name: "Android Software Development Kit License Agreement", url: "https://developer.android.com/studio/terms", acceptanceRequired: true } }],
  progress: {},
  errors: {},
};

function plan(patch: Partial<Plan> = {}): Plan {
  return { components: [], install: [], downloadBytes: 0, installBytes: 0, unknownSizes: 0, licenses: [], warnings: [], ...patch };
}

function setup(ipc: Partial<WorkloadsIpc> = {}) {
  const full: WorkloadsIpc = {
    workloadsCatalog: vi.fn().mockResolvedValue(CATALOG),
    workloadsPlan: vi.fn().mockResolvedValue(plan()),
    workloadsFirstRun: vi.fn().mockResolvedValue(true),
    workloadsFirstRunDone: vi.fn().mockResolvedValue(undefined),
    runtimeVerify: vi.fn().mockResolvedValue("21.0.12.1"),
    ...ipc,
  };
  const install = vi.fn().mockResolvedValue(true);
  const workloads = new WorkloadService({
    ipc: full,
    events: new EventBus<AppEvents>(),
    install,
    installError: () => null,
    refreshRuntimes: () => Promise.resolve(),
  });
  const network = {
    subscribe: () => () => undefined,
    getState: () => NETWORK_STATE,
    load: vi.fn().mockResolvedValue(undefined),
    chooseImport: vi.fn().mockResolvedValue(undefined),
    openWindow: vi.fn().mockResolvedValue(undefined),
  };
  const runtime = { subscribe: () => () => undefined, getState: () => RUNTIME_STATE };
  harness.current = { workloads, network, runtime, run: vi.fn(), ipc: { openExternalUrl: vi.fn() } };
  return { workloads, ipc: full, install, network };
}

afterEach(() => {
  cleanup();
  i18n.setLanguage("en");
  harness.current = null;
});

describe("WorkloadsPage", () => {
  it("shows the installer steps, the workload cards, runtime cards and the summary", async () => {
    const r = setup({ workloadsPlan: vi.fn().mockResolvedValue(plan({ install: ["maven"], downloadBytes: 9_395_475, installBytes: 10_869_833 })) });
    render(<WorkloadsPage firstRun={false} />);
    await act(() => r.workloads.load());
    const nav = screen.getByRole("navigation", { name: "Steps" });
    for (const step of ["Welcome", "Installation Location", "Workloads & Runtimes", "Language Packs", "Network & Proxy", "Offline Packages", "Summary", "Install"]) {
      expect(within(nav).getByRole("button", { name: step })).toBeInTheDocument();
    }
    act(() => {
      r.workloads.setSection("workloads");
    });
    expect(screen.getByRole("article", { name: "Java / Kotlin development" })).toBeInTheDocument();
    // An external component's card has no Install button: its reason is shown instead.
    const msvc = screen.getByRole("article", { name: "Visual Studio Build Tools (MSVC)" });
    expect(within(msvc).queryByRole("button", { name: "Install" })).toBeNull();
    expect(within(msvc).getByText(/Visual Studio installer and admin rights/)).toBeInTheDocument();
    expect(within(msvc).getByText("Admin required")).toBeInTheDocument();
    // A heavy SDK is installable and says how big it is.
    const flutter = screen.getByRole("article", { name: "Flutter SDK" });
    expect(within(flutter).getByRole("button", { name: "Install" })).toBeEnabled();
    expect(within(flutter).getByText("1.80 GB")).toBeInTheDocument();
    // Selecting a workload updates the summary from the plan.
    await act(async () => {
      fireEvent.click(within(screen.getByRole("article", { name: "Java / Kotlin development" })).getByRole("checkbox"));
      await Promise.resolve();
    });
    const summary = screen.getByRole("complementary", { name: "Summary" });
    expect(within(summary).getByText("Maven 1.0")).toBeInTheDocument();
    expect(within(summary).getByText("9.0 MB")).toBeInTheDocument();
    expect(within(summary).getByText("C:/app/runtimes")).toBeInTheDocument();
  });

  it("Install selected asks for the vendor licence first and installs only after it is accepted", async () => {
    const r = setup({ workloadsPlan: vi.fn().mockResolvedValue(plan({ install: ["jdk", "android-cmdline-tools"], licenses: ["android-cmdline-tools"] })) });
    render(<WorkloadsPage firstRun={false} />);
    await act(() => r.workloads.load());
    fireEvent.click(screen.getByRole("button", { name: "Install selected" }));
    await act(() => Promise.resolve());
    const dialog = screen.getByRole("dialog", { name: "Accept licences" });
    expect(within(dialog).getByText(/Android Software Development Kit License Agreement/)).toBeInTheDocument();
    expect(r.install).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "I accept — install" }));
      await Promise.resolve();
    });
    expect(r.install.mock.calls).toEqual([["jdk", true], ["android-cmdline-tools", true]]);
  });

  it("with nothing installable selected, Install selected is disabled with the reason", async () => {
    const r = setup();
    render(<WorkloadsPage firstRun={false} />);
    await act(() => r.workloads.load());
    const button = screen.getByRole("button", { name: "Install selected" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Nothing to install: select something OpenMind can install.");
  });

  it("the first-run page appears once and Skip closes it without installing anything (Russian)", async () => {
    const r = setup();
    i18n.setLanguage("ru");
    render(<FirstRunWorkloads />);
    await act(async () => {
      await r.workloads.maybeOpenFirstRun();
    });
    expect(screen.getByRole("dialog", { name: "Выберите, что установить" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(r.ipc.workloadsFirstRunDone).toHaveBeenCalled();
    expect(r.install).not.toHaveBeenCalled();
  });
});

/** The Runtime Manager's runtime list as the RuntimeService holds it (only what the wiring and the page read). */
function runtimeList(jdkInstalled: boolean) {
  return {
    ...RUNTIME_STATE,
    runtimes: [
      ...RUNTIME_STATE.runtimes.map((r) => ({ ...r, installed: [], activeVersion: null })),
      { id: "jdk", installed: jdkInstalled ? [{ version: "21.0.12.1", healthy: true }] : [], activeVersion: jdkInstalled ? "21.0.12.1" : null },
    ],
  };
}

function jdk(state: "installed" | "available"): WorkloadCatalog {
  return { ...CATALOG, components: CATALOG.components.map((c) => (c.id === "jdk" ? { ...c, state } : c)) };
}

describe("WorkloadsPage follows the Runtimes tab", () => {
  it("a runtime deleted and reinstalled on the Runtimes tab updates its card, Install button and the summary without reopening", async () => {
    let installed = true;
    const listeners = new Set<() => void>();
    let runtimeState = runtimeList(true);
    const runtime = {
      getState: () => runtimeState,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      install: vi.fn().mockResolvedValue(true),
      refresh: () => Promise.resolve(),
    };
    /** What the Runtimes tab's Delete / Install does: the backend changes, the RuntimeService reloads its list. */
    const changeOnRuntimesTab = async (nowInstalled: boolean) => {
      installed = nowInstalled;
      runtimeState = runtimeList(nowInstalled);
      await act(async () => {
        for (const listener of [...listeners]) listener();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const ipc: WorkloadsIpc = {
      workloadsCatalog: vi.fn(() => Promise.resolve(jdk(installed ? "installed" : "available"))),
      workloadsPlan: vi.fn(() =>
        Promise.resolve(
          installed
            ? plan({ install: ["maven"] })
            : plan({ install: ["jdk", "maven"], warnings: [{ kind: "dependencyAdded", component: "jdk", neededBy: "maven" }] }),
        ),
      ),
      workloadsFirstRun: vi.fn().mockResolvedValue(false),
      workloadsFirstRunDone: vi.fn().mockResolvedValue(undefined),
      runtimeVerify: vi.fn().mockResolvedValue("21.0.12.1"),
    };
    const workloads = wireWorkloads({ ipc, events: new EventBus<AppEvents>(), commands: new CommandRegistry(), runtime: runtime as never });
    const network = { subscribe: () => () => undefined, getState: () => NETWORK_STATE, load: vi.fn().mockResolvedValue(undefined) };
    harness.current = { workloads, network, runtime, run: vi.fn(), ipc: { openExternalUrl: vi.fn() } };

    render(<WorkloadsPage firstRun={false} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    act(() => {
      workloads.setSection("workloads");
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("article", { name: "Java / Kotlin development" })).getByRole("checkbox"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const card = () => screen.getByRole("article", { name: "Java JDK (Temurin 21)" });
    const summary = () => screen.getByRole("complementary", { name: "Summary" });
    /** The card's state chip (the header holds only the name and the state). */
    const chip = () => card().querySelector("header")?.textContent.replace("Java JDK (Temurin 21)", "");
    expect(chip()).toBe("Installed");
    expect(within(card()).getByRole("button", { name: "Install" })).toBeDisabled();
    expect(within(summary()).queryByText("Java JDK (Temurin 21) 1.0")).toBeNull();

    await changeOnRuntimesTab(false);
    expect(chip()).toBe("Available");
    expect(within(card()).getByRole("button", { name: "Install" })).toBeEnabled();
    expect(within(summary()).getByText("Java JDK (Temurin 21) 1.0", { exact: false })).toBeInTheDocument();
    act(() => {
      workloads.setSection("summary");
    });
    expect(screen.getByText("Java JDK (Temurin 21) was added because Maven needs it.")).toBeInTheDocument();
    act(() => {
      workloads.setSection("workloads");
    });

    await changeOnRuntimesTab(true);
    expect(chip()).toBe("Installed");
    expect(within(card()).getByRole("button", { name: "Install" })).toBeDisabled();
    act(() => {
      workloads.setSection("summary");
    });
    expect(screen.queryByText("Java JDK (Temurin 21) was added because Maven needs it.")).toBeNull();
    expect(ipc.workloadsCatalog).toHaveBeenCalledTimes(3);
  });
});
