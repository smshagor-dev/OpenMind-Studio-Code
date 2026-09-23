import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../services/eventBus";
import type { AppEvents } from "../services/events";
import type { InstallProgress, RuntimeStatus } from "../services/ipc";
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
    busy: false,
    ...overrides,
  };
}

describe("RuntimeManagerDialog", () => {
  let ipc: ReturnType<typeof createFakeIpc>;
  let service: RuntimeService;
  let pushProgress: (p: InstallProgress) => void;

  async function open(runtimes: RuntimeStatus[]) {
    ipc = createFakeIpc({
      runtimeList: vi.fn().mockResolvedValue(runtimes),
      runtimeInstall: vi.fn().mockResolvedValue({}),
      onRuntimeProgress: vi.fn((handler: typeof pushProgress) => {
        pushProgress = handler;
        return Promise.resolve(() => undefined);
      }),
    });
    service = new RuntimeService(ipc, new EventBus<AppEvents>());
    harness.current = { runtime: service };
    const onClose = vi.fn();
    render(<RuntimeManagerDialog onClose={onClose} />);
    await screen.findByRole("region", { name: runtimes[0]?.displayName ?? "" });
    return onClose;
  }

  beforeEach(() => {
    harness.current = null;
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

  it("shows a copy already on the system PATH as information", async () => {
    await open([runtime({ globalVersion: "20.1.0" })]);

    expect(screen.getByText("System: 20.1.0")).toBeInTheDocument();
  });

  it("installs the selected version when Install is clicked", async () => {
    await open([runtime()]);

    fireEvent.change(screen.getByLabelText("Node.js version to install"), {
      target: { value: "24.20.0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(ipc.runtimeInstall).toHaveBeenCalledWith("node", "24.20.0");
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

      expect(ipc.runtimeInstall).toHaveBeenCalledWith("git", "2.55.0.5");
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

  it("closes from the Close button", async () => {
    const onClose = await open([runtime()]);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });
});
