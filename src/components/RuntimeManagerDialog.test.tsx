import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { InstallProgress, LspServerInfo, RuntimeStatus } from "../services/ipc";
import { RuntimeService } from "../services/runtimeService";
import { createFakeIpc } from "../testUtils/fakeIpcClient";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { RuntimeManagerDialog } from "./RuntimeManagerDialog";

function runtime(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    id: "node",
    displayName: "Node.js",
    description: "JavaScript runtime.",
    notes: "",
    defaultVersion: "24.21.0",
    availableVersions: ["24.21.0", "24.20.0"],
    installed: [],
    activeVersion: null,
    globalVersion: null,
    requires: [],
    license: null,
    downloadBytes: null,
    installBytes: null,
    busy: false,
    ...overrides,
  };
}

describe("RuntimeManagerDialog", () => {
  let ipc: ReturnType<typeof createFakeIpc>;
  let service: RuntimeService;
  let pushProgress: (p: InstallProgress) => void;

  async function open(runtimes: RuntimeStatus[], servers: LspServerInfo[] = []) {
    ipc = createFakeIpc({
      runtimeList: vi.fn().mockResolvedValue(runtimes),
      runtimeInstall: vi.fn().mockResolvedValue({}),
      onRuntimeProgress: vi.fn((handler: typeof pushProgress) => {
        pushProgress = handler;
        return Promise.resolve(() => undefined);
      }),
    });
    service = new RuntimeService(ipc, new EventBus<AppEvents>());
    const lspState = { snapshot: null };
    const lsp = {
      subscribe: () => () => undefined,
      getState: () => lspState,
      servers: () => servers,
      isInstalling: () => false,
      install: vi.fn().mockResolvedValue(true),
      uninstall: vi.fn().mockResolvedValue(true),
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    const toolchainState = { loaded: false };
    const toolchains = {
      subscribe: () => () => undefined,
      getState: () => toolchainState,
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    harness.current = {
      runtime: service,
      lsp,
      toolchains,
      workloads: { takeRequestedTab: () => null, peekRequestedTab: () => null },
    };
    const onClose = vi.fn();
    render(<RuntimeManagerDialog onClose={onClose} />);
    await screen.findByRole("region", { name: runtimes[0]?.displayName ?? "" });
    return onClose;
  }

  beforeEach(() => {
    harness.current = null;
  });

  it("offers language servers on the Language Tools tab, not on the runtime cards", async () => {
    const fortls = {
      id: "fortran",
      name: "fortls",
      languages: ["fortran"],
      note: null,
      contents: "fortls 3.2.2",
      runtime: "pythonModule",
      installed: false,
      bundled: false,
      installSource: null,
      state: "stopped",
      workspace: null,
      node: null,
      capabilities: null,
      openDocuments: 0,
      pid: null,
      canInstall: true,
      installBlocked: null,
      logPath: "C:/app/logs/lsp/fortran.log",
      logExists: false,
    } satisfies LspServerInfo;
    await open(
      [
        runtime({ id: "fortran", displayName: "Fortran" }),
        runtime({ id: "pascal", displayName: "Free Pascal" }),
      ],
      [fortls],
    );
    const fortran = screen.getByRole("region", { name: "Fortran" });
    expect(within(fortran).queryByText(/Language Tools/)).toBeNull();
    expect(within(fortran).queryByRole("button", { name: /Install Language Tools/ })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Language Tools" }));
    const section = screen.getByRole("region", { name: "Language servers" });
    const card = within(section).getByRole("article", { name: "fortls" });
    expect(card).toHaveTextContent("Fortran");
    expect(card).toHaveTextContent("Missing");
    fireEvent.click(within(card).getByRole("button", { name: "Install" }));
    const lsp = (harness.current as { lsp: { install: ReturnType<typeof vi.fn> } }).lsp;
    expect(lsp.install).toHaveBeenCalledWith("fortran");
    expect(within(section).getByRole("button", { name: "Install all missing (1)" })).toBeTruthy();
  });

  it("lists each runtime with its installed / not installed status", async () => {
    await open([
      runtime(),
      runtime({
        id: "git",
        displayName: "Git",
        installed: [{ version: "2.55.0.5", path: "p", active: true, healthy: true, features: [] }],
        activeVersion: "2.55.0.5",
        availableVersions: ["2.55.0.5"],
        defaultVersion: "2.55.0.5",
      }),
    ]);

    const node = screen.getByRole("region", { name: "Node.js" });
    const git = screen.getByRole("region", { name: "Git" });
    expect(within(node).getByText("Not installed")).toBeInTheDocument();
    expect(within(git).getByText("Installed")).toBeInTheDocument();
    expect(within(git).getByText("Active: 2.55.0.5")).toBeInTheDocument();
  });

  it("does not claim a debug adapter is on the terminal PATH", async () => {
    await open([
      runtime({
        id: "debugpy",
        displayName: "Python debugger (debugpy)",
        installed: [{ version: "1.8.22", path: "p", active: true, healthy: true, features: [] }],
        activeVersion: "1.8.22",
        availableVersions: ["1.8.22"],
        defaultVersion: "1.8.22",
      }),
    ]);

    const card = screen.getByRole("region", { name: "Python debugger (debugpy)" });
    expect(within(card).getByText(/Used only by the debugger/)).toBeInTheDocument();
    expect(within(card).queryByText("In new terminals’ PATH")).toBeNull();
    expect(within(card).queryByText("In new terminals' PATH")).toBeNull();
  });

  it("shows a copy already on the system PATH as information", async () => {
    await open([runtime({ globalVersion: "20.1.0" })]);

    expect(screen.getByText("System: 20.1.0")).toBeInTheDocument();
  });

  it("filters runtimes from the search box", async () => {
    await open([
      runtime(),
      runtime({
        id: "fortran",
        displayName: "Fortran (GFortran)",
        description: "Compile, run and build Fortran programs with gfortran, GCC, Make and GDB.",
        notes: "Use it to compile .f/.f90 files.",
        defaultVersion: "13.1.0",
        availableVersions: ["13.1.0"],
      }),
      runtime({
        id: "pascal",
        displayName: "Pascal (Free Pascal)",
        description: "Compile and run Pascal programs for Windows x64 with Free Pascal.",
        defaultVersion: "3.2.3",
        availableVersions: ["3.2.3"],
      }),
    ]);

    const search = screen.getByRole("searchbox", { name: "Search runtimes" });
    expect(screen.getByText("3 of 3")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "gfortran" } });

    expect(screen.getByRole("region", { name: "Fortran (GFortran)" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Node.js" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Pascal (Free Pascal)" })).toBeNull();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "ruby" } });

    expect(screen.queryByRole("region", { name: "Fortran (GFortran)" })).toBeNull();
    expect(screen.getByText("No runtimes match that search.")).toBeInTheDocument();
  });

  it("installs the selected version when Install is clicked", async () => {
    await open([runtime()]);

    fireEvent.change(screen.getByLabelText("Node.js version to install"), {
      target: { value: "24.20.0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(ipc.runtimeInstall).toHaveBeenCalledWith("node", "24.20.0", false);
  });

  it("disables Install for an installed version and explains why", async () => {
    await open([
      runtime({
        installed: [{ version: "24.21.0", path: "p", active: true, healthy: true, features: [] }],
        activeVersion: "24.21.0",
      }),
    ]);

    const install = screen.getByRole("button", { name: "Install" });

    expect(install).toBeDisabled();
    expect(install).toHaveAttribute("title", expect.stringContaining("already installed"));
  });

  it("gives a runtime with no download for this platform a disabled Install and a reason", async () => {
    await open([runtime({ availableVersions: [] })]);

    const install = screen.getByRole("button", { name: "Install" });

    expect(install).toBeDisabled();
    expect(install).toHaveAttribute("title", expect.stringContaining("no download"));
    expect(screen.queryByLabelText("Node.js version to install")).not.toBeInTheDocument();
  });

  it("renders download, verification and extraction progress as they arrive", async () => {
    await open([runtime()]);
    ipc.runtimeInstall = vi.fn(() => new Promise<never>(() => undefined));
    void service.install("node", "24.21.0");

    pushProgress({ kind: "node", version: "24.21.0", phase: "download", current: 30, total: 100 });
    expect(await screen.findByText(/Downloading 30%/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");

    pushProgress({ kind: "node", version: "24.21.0", phase: "verify", current: 100, total: 100 });
    expect(await screen.findByText(/Verifying checksum 100%/)).toBeInTheDocument();

    pushProgress({ kind: "node", version: "24.21.0", phase: "extract", current: 1, total: 4 });
    expect(await screen.findByText(/Extracting 25%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled();
  });

  it("shows the backend's error with its recovery advice, and Dismiss clears it", async () => {
    await open([runtime()]);
    ipc.runtimeInstall = vi
      .fn()
      .mockRejectedValue("checksum mismatch. The file was discarded. Try again.");

    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("checksum mismatch. The file was discarded. Try again.");
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  describe("installed versions", () => {
    const two = runtime({
      installed: [
        { version: "24.21.0", path: "p1", active: true, healthy: true, features: [] },
        { version: "24.20.0", path: "p2", active: false, healthy: true, features: [] },
      ],
      activeVersion: "24.21.0",
    });

    it("marks the active version, offers Set active only on the others, and switches", async () => {
      await open([two]);
      const rows = screen.getAllByRole("listitem");
      expect(within(rows[0] as HTMLElement).getByText("Active")).toBeInTheDocument();
      expect(
        within(rows[0] as HTMLElement).queryByRole("button", { name: "Set active" }),
      ).toBeNull();

      fireEvent.click(within(rows[1] as HTMLElement).getByRole("button", { name: "Set active" }));

      expect(ipc.runtimeSetActive).toHaveBeenCalledWith("node", "24.20.0");
    });

    it("keeps Repair disabled with a reason on a healthy install, and Delete removes that version", async () => {
      await open([two]);
      const row = screen.getAllByRole("listitem")[1] as HTMLElement;

      const repair = within(row).getByRole("button", { name: "Repair" });
      expect(repair).toBeDisabled();
      expect(repair).toHaveAttribute("title", expect.stringContaining("intact"));

      fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
      expect(ipc.runtimeDelete).toHaveBeenCalledWith("node", "24.20.0");
    });

    it("flags a damaged install and enables Repair, disabling Set active until it's fixed", async () => {
      ipc = createFakeIpc();
      await open([
        runtime({
          installed: [
            { version: "24.21.0", path: "p1", active: true, healthy: true, features: [] },
            { version: "24.20.0", path: "p2", active: false, healthy: false, features: [] },
          ],
          activeVersion: "24.21.0",
        }),
      ]);
      const row = screen.getAllByRole("listitem")[1] as HTMLElement;

      expect(within(row).getByText("Needs repair")).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "Repair" })).toBeEnabled();
      expect(within(row).getByRole("button", { name: "Set active" })).toBeDisabled();

      fireEvent.click(within(row).getByRole("button", { name: "Repair" }));
      expect(ipc.runtimeRepair).toHaveBeenCalledWith("node", "24.20.0");
    });
  });

  describe("Python and Git", () => {
    const python = (overrides: Partial<RuntimeStatus["installed"][number]> = {}) =>
      runtime({
        id: "python",
        displayName: "Python",
        defaultVersion: "3.14.7",
        availableVersions: ["3.14.7", "3.13.13"],
        installed: [
          {
            version: "3.14.7",
            path: "p",
            active: true,
            healthy: true,
            features: [
              { id: "pip", label: "pip", available: true, note: "" },
              { id: "venv", label: "venv", available: true, note: "" },
            ],
            ...overrides,
          },
        ],
        activeVersion: "3.14.7",
      });

    it("offers an add-on of an installed version (Tcl/Tk) with Add, then Remove once it is there", async () => {
      const addon = {
        id: "tcltk",
        label: "Tcl/Tk GUI support (tkinter)",
        description: "python.org's Tcl/Tk package.",
        installed: false,
        available: true,
        downloadBytes: 5_414_912,
        installBytes: 10_939_413,
        license: { name: "Tcl/Tk License", url: "https://example.com" },
      };
      await open([python({ addons: [addon] })]);

      expect(screen.getByText("Tcl/Tk GUI support (tkinter): not installed")).toBeInTheDocument();
      expect(screen.getByText("· 5.2 MB · Tcl/Tk License")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await waitFor(() => {
        expect(ipc.runtimeAddonInstall).toHaveBeenCalledWith("python", "3.14.7", "tcltk");
      });
      expect(service.addableAddon("python", "tcltk")).toMatchObject({ version: "3.14.7" });

      cleanup();
      await open([python({ addons: [{ ...addon, installed: true }] })]);
      expect(screen.getByText("Tcl/Tk GUI support (tkinter): installed")).toBeInTheDocument();
      expect(service.addableAddon("python", "tcltk")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      await waitFor(() => {
        expect(ipc.runtimeAddonRemove).toHaveBeenCalledWith("python", "3.14.7", "tcltk");
      });
    });

    it("shows pip and venv as available, and that new terminals get the active version", async () => {
      await open([python()]);

      expect(screen.getByText("pip: available")).toBeInTheDocument();
      expect(screen.getByText("venv: available")).toBeInTheDocument();
      expect(screen.getByText("In new terminals' PATH")).toBeInTheDocument();
    });

    it("labels the pip launcher as relocatable and still reports it available", async () => {
      await open([
        python({
          features: [{ id: "pip", label: "pip (relocatable launcher)", available: true, note: "" }],
        }),
      ]);

      expect(screen.getByText("pip (relocatable launcher): available")).toBeInTheDocument();
      expect(screen.getByText("In new terminals' PATH")).toBeInTheDocument();
    });

    it("says plainly when pip is missing, with the reason, and offers Repair", async () => {
      await open([
        python({
          healthy: false,
          features: [
            {
              id: "pip",
              label: "pip",
              available: false,
              note: "pip isn't set up in this install. Use Repair to reinstall it.",
            },
          ],
        }),
      ]);

      expect(screen.getByText(/pip: not available — pip isn't set up/)).toBeInTheDocument();
      expect(screen.getByText(/Not in terminal PATH — needs repair/)).toBeInTheDocument();
      const row = screen.getByRole("listitem");
      expect(within(row).getByRole("button", { name: "Repair" })).toBeEnabled();
    });

    it("installs Python and Git through the same Install button, and shows the runtime's error", async () => {
      await open([
        python({ version: "3.13.13", active: false }),
        runtime({
          id: "git",
          displayName: "Git",
          defaultVersion: "2.55.0.5",
          availableVersions: ["2.55.0.5"],
        }),
      ]);
      ipc.runtimeInstall = vi
        .fn()
        .mockRejectedValue("setup step failed: pip. Nothing was installed. Try again.");

      const git = screen.getByRole("region", { name: "Git" });
      fireEvent.click(within(git).getByRole("button", { name: "Install" }));

      expect(ipc.runtimeInstall).toHaveBeenCalledWith("git", "2.55.0.5", false);
      expect(await within(git).findByRole("alert")).toHaveTextContent("Nothing was installed");
    });

    it("a Git install that is not active is labelled as such", async () => {
      await open([
        runtime({
          id: "git",
          displayName: "Git",
          installed: [
            { version: "2.55.0.5", path: "p", active: false, healthy: true, features: [] },
          ],
        }),
      ]);

      expect(screen.getByText(/not the active version/)).toBeInTheDocument();
    });
  });

  it("keeps a card short: the long Python notes are in Details, not on the card", async () => {
    const notes =
      "python.org NuGet package: full standard library with venv and pip. pip and pip3 are small launchers written next to the runtime.";
    await open([
      runtime({
        id: "python",
        displayName: "Python",
        description: "Python interpreter with pip and venv (the python.org NuGet distribution).",
        notes,
      }),
    ]);
    const card = screen.getByRole("region", { name: "Python" });
    // The card shows the short description (styled to two lines, the full text as its tooltip), never the notes.
    const description = within(card).getByText(/Python interpreter with pip and venv/);
    expect(description).toHaveClass("runtime-card__description");
    expect(description).toHaveAttribute("title", expect.stringContaining("NuGet distribution"));
    expect(within(card).queryByText(/small launchers/)).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Details" }));
    const details = screen.getByRole("dialog", { name: "Python" });
    expect(
      within(details).getByText(/small launchers written next to the runtime/),
    ).toBeInTheDocument();
    fireEvent.click(within(details).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Python" })).toBeNull();
  });

  it("has Runtimes, Language Tools and Workloads tabs, opening on Runtimes", async () => {
    await open([runtime()]);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Runtimes", "Language Tools", "Workloads"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("closes from the Close button", async () => {
    const onClose = await open([runtime()]);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });
});
