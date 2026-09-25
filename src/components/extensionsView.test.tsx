import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExtensionMarketplaceService } from "../services/extensionMarketplaceService";
import type { MarketplaceApi } from "../services/marketplaceIpc";
import { command, type Rig, rig } from "../testUtils/extensionRig";
import { emptyExtensionsSnapshot, testExtension } from "../testUtils/fakeExtensionsIpc";
import { createFakeMarketplaceApi, marketItem } from "../testUtils/fakeMarketplaceApi";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { ExtensionDialogs } from "./ExtensionDialogs";
import { ExtensionEditor } from "./ExtensionEditor";
import { ExtensionPrompts } from "./ExtensionPrompts";
import { ExtensionsView } from "./ExtensionsView";

/** An installed extension that isn't on Open VSX (installed from a local .vsix). */
const LOCAL_ONLY: Partial<MarketplaceApi> = {
  details: vi.fn().mockRejectedValue("openmind-samples.sample-command isn't on Open VSX."),
};

async function mount(
  extensions = [] as ReturnType<typeof testExtension>[],
  overrides: Parameters<typeof rig>[1] = {},
  market: Partial<MarketplaceApi> = LOCAL_ONLY,
): Promise<Rig & { api: MarketplaceApi; marketplace: ExtensionMarketplaceService }> {
  const r = rig(extensions, overrides);
  const api = createFakeMarketplaceApi(market);
  const marketplace = new ExtensionMarketplaceService(api, {
    install: (path) => r.service.inspect(path),
    onError: (message) => r.errors.push(message),
  });
  harness.current = {
    extensions: {
      registry: r.registry,
      service: r.service,
      host: r.host,
      marketplace,
      prompts: r.prompts,
      contributions: r.contributions,
    },
    ipc: r.ipc,
    run: vi.fn(),
    commands: r.commands,
  };
  await r.registry.initialize();
  render(
    <>
      <ExtensionsView />
      <ExtensionEditor />
      <ExtensionDialogs />
      <ExtensionPrompts />
    </>,
  );
  return { ...r, api, marketplace };
}

/** Opens one of the view's menus (they open on mouse down) and returns it. */
async function openMenu(label: string): Promise<HTMLElement> {
  fireEvent.mouseDown(screen.getByRole("button", { name: label }));
  return screen.findByRole("menu", { name: label });
}

function menuItem(menu: HTMLElement, text: string): HTMLElement {
  const row = within(menu).getByText(text).closest("[role=menuitem]");
  if (!(row instanceof HTMLElement)) throw new Error(`no menu item ${text}`);
  return row;
}

beforeEach(() => {
  harness.current = null;
});

describe("ExtensionsView", () => {
  it("lists Popular extensions from Open VSX, with Installed above, VS Code style", async () => {
    const r = await mount();
    expect(screen.getByPlaceholderText("Search Extensions in Marketplace")).toBeTruthy();
    expect(await screen.findByText("No extensions installed.")).toBeTruthy();
    const popular = await screen.findByLabelText("Marketplace extensions");
    expect(within(popular).getByText("Python")).toBeTruthy();
    expect(within(popular).getByText("59.1M")).toBeTruthy();
    expect(within(popular).getByText("3.9")).toBeTruthy();
    expect(within(popular).getByRole("button", { name: "Install" })).toBeTruthy();
    // An empty search lists the most installed extensions.
    expect(r.api.search).toHaveBeenCalledWith("", "installs", 0, 30);
  });

  it("searches the marketplace as you type", async () => {
    const r = await mount(
      [],
      {},
      {
        ...LOCAL_ONLY,
        search: vi.fn().mockImplementation((query: string) =>
          Promise.resolve({
            total: 1,
            offset: 0,
            items: [
              query === "yaml"
                ? marketItem({ namespace: "redhat", name: "vscode-yaml", displayName: "YAML" })
                : marketItem(),
            ],
          }),
        ),
      },
    );
    fireEvent.change(screen.getByLabelText("Search Extensions in Marketplace"), {
      target: { value: "yaml" },
    });
    expect(await screen.findByText("YAML")).toBeTruthy();
    expect(r.api.search).toHaveBeenLastCalledWith("yaml", "relevance", 0, 30);
    expect(screen.getByLabelText("Marketplace")).toBeTruthy();
  });

  it("says so when Open VSX can't be reached, with Retry", async () => {
    await mount([], {}, { search: vi.fn().mockRejectedValue("offline") });
    expect(await screen.findByText("Couldn't reach the marketplace (Open VSX).")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("installs from the marketplace through the same trust dialog", async () => {
    const r = await mount();
    vi.mocked(r.ipc.extInspectVsix).mockResolvedValue(command);
    const popular = await screen.findByLabelText("Marketplace extensions");
    fireEvent.click(within(popular).getByRole("button", { name: "Install" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(r.api.download).toHaveBeenCalledWith("ms-python", "python");
    expect(
      within(dialog).getByText(
        "Extensions can run code on your computer. Install only from trusted sources.",
      ),
    ).toBeTruthy();
    expect(r.ipc.extInstall).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => {
      expect(r.ipc.extInstall).toHaveBeenCalledWith(
        "C:/app/cache/extensions/ms-python.python-2026.4.0.vsix",
        false,
      );
    });
  });

  it("opens the extension page with the README from Open VSX", async () => {
    const r = await mount([], {}, {});
    const popular = await screen.findByLabelText("Marketplace extensions");
    fireEvent.click(within(popular).getByRole("button", { name: "Python, ms-python" }));
    const page = await screen.findByLabelText("Extension: Python", { selector: "section" });
    expect(await within(page).findByText("The README.")).toBeTruthy();
    expect(within(page).getByText("Microsoft")).toBeTruthy();
    expect(within(page).getByText("Programming Languages")).toBeTruthy();
    expect(within(page).getByRole("button", { name: "Install" })).toBeTruthy();
    fireEvent.click(within(page).getByRole("tab", { name: "Changelog" }));
    await waitFor(() => {
      expect(r.api.text).toHaveBeenCalledWith(
        "https://open-vsx.org/api/ms-python/python/2026.4.0/file/CHANGELOG.md",
      );
    });
    fireEvent.click(within(page).getByRole("button", { name: "Close extension page" }));
    expect(screen.queryByLabelText("Extension: Python", { selector: "section" })).toBeNull();
  });

  it("lists installed extensions and filters them with @installed", async () => {
    const other = testExtension({
      enabled: false,
      manifest: { ...command.manifest, name: "other", displayName: "Zebra Tools" },
    });
    await mount([command, other], { node: { portable: true, system: null, allowSystem: false } });
    const list = await screen.findByLabelText("Installed extensions");
    expect(within(list).getByText("Sample Command")).toBeTruthy();
    expect(within(list).getByText("Zebra Tools")).toBeTruthy();
    expect(within(list).getByText("Disabled")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search Extensions in Marketplace"), {
      target: { value: "@installed zebra" },
    });
    expect(
      within(screen.getByLabelText("Installed extensions")).queryByText("Sample Command"),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("Search Extensions in Marketplace"), {
      target: { value: "@installed zzz" },
    });
    expect(await screen.findByText("No installed extension matches.")).toBeTruthy();
  });

  it("an installed extension's page shows its features, activation and unsupported points", async () => {
    const extension = testExtension({
      warnings: ['Activates at every start-up ("*"), which can slow the app down.'],
      activationEvents: ["onCommand:sampleCommand.hello", "*"],
      points: [
        { point: "commands", count: 1, support: "supported", note: null },
        { point: "viewsContainers", count: 1, support: "unsupported", note: null },
      ],
    });
    await mount([extension], { node: { portable: true, system: null, allowSystem: false } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Sample Command, openmind-samples" }),
    );
    const page = await screen.findByLabelText("Extension: Sample Command", { selector: "section" });
    expect(await within(page).findByText(/Not available on Open VSX/)).toBeTruthy();
    expect(within(page).getByRole("button", { name: "Disable" })).toBeTruthy();
    fireEvent.click(within(page).getByRole("tab", { name: "Features" }));
    const details = within(page).getByLabelText("Sample Command details", { selector: "section" });
    expect(within(details).getByText(extension.path)).toBeTruthy();
    expect(within(details).getByText('When the command "sampleCommand.hello" runs')).toBeTruthy();
    const points = within(details).getByLabelText("Contribution points");
    expect(within(points).getByText(/This contribution point is not supported yet./)).toBeTruthy();
  });

  it("Install from VSIX... (in the … menu) asks with the trust warning first", async () => {
    const r = await mount();
    vi.mocked(r.ipc.extPickVsix).mockResolvedValue("C:/My Downloads/sample.vsix");
    vi.mocked(r.ipc.extInspectVsix).mockResolvedValue(command);
    fireEvent.click(menuItem(await openMenu("More Actions"), "Install from VSIX..."));
    const dialog = await screen.findByRole("alertdialog");
    expect(r.ipc.extInstall).not.toHaveBeenCalled();
    r.snapshot.current = emptyExtensionsSnapshot({ extensions: [command] });
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => {
      expect(r.ipc.extInstall).toHaveBeenCalledWith("C:/My Downloads/sample.vsix", false);
    });
    expect(await screen.findByText("Installed Sample Command 1.0.0.")).toBeTruthy();
  });

  it("cancelling the trust dialog installs nothing", async () => {
    const r = await mount();
    vi.mocked(r.ipc.extPickVsix).mockResolvedValue("C:/a.vsix");
    fireEvent.click(menuItem(await openMenu("More Actions"), "Install from VSIX..."));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(r.ipc.extInstall).not.toHaveBeenCalled();
  });

  it("Restart Extension Host is disabled with its reason while there is nothing to run", async () => {
    await mount();
    const restart = menuItem(await openMenu("More Actions"), "Restart Extension Host");
    expect(restart.getAttribute("aria-disabled")).toBe("true");
    expect(restart.getAttribute("title")).toBe("No installed extension has code to run.");
  });

  it("disables and uninstalls (after a confirmation) from the gear menu", async () => {
    const r = await mount([command], {
      node: { portable: true, system: null, allowSystem: false },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Manage Sample Command" }));
    fireEvent.click(menuItem(await screen.findByRole("menu", { name: "Manage" }), "Disable"));
    await waitFor(() => {
      expect(r.ipc.extSetEnabled).toHaveBeenCalledWith(command.id, false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Manage Sample Command" }));
    fireEvent.click(menuItem(await screen.findByRole("menu", { name: "Manage" }), "Uninstall"));
    const dialog = await screen.findByRole("alertdialog");
    expect(r.ipc.extUninstall).not.toHaveBeenCalled();
    r.snapshot.current = emptyExtensionsSnapshot();
    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    await waitFor(() => {
      expect(r.ipc.extUninstall).toHaveBeenCalledWith(command.id);
    });
    expect(await screen.findByText("No extensions installed.")).toBeTruthy();
  });

  it("says Node.js is required and offers the machine's Node only as an explicit choice", async () => {
    const r = await mount([command], {
      node: { portable: false, system: "C:/Program Files/nodejs/node.exe", allowSystem: false },
    });
    const alerts = await screen.findAllByText("Node.js runtime is required for extension host.");
    expect(alerts.length).toBeGreaterThan(0);
    expect(screen.getByText(/OpenMind Studio only uses it if you allow it/)).toBeTruthy();
    expect(r.ipc.extHostStart).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use System Node.js" })).toBeTruthy();
  });

  it("shows a crashed extension host and an extension's activation error", async () => {
    await mount([command], {
      node: { portable: true, system: null, allowSystem: false },
      host: {
        state: "crashed",
        pid: null,
        node: null,
        error: "The extension host stopped unexpectedly.",
      },
      activity: {
        [command.id]: {
          active: false,
          lastError: "Activating a.b failed: boom",
          activationCount: 0,
          lastActivation: null,
        },
      },
    });
    expect(await screen.findByText("The extension host stopped unexpectedly.")).toBeTruthy();
    expect(screen.getByText("Activating a.b failed: boom")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart Extension Host" })).toBeTruthy();
  });

  it("shows what an extension asks: a message with buttons, and the clicked button is returned", async () => {
    const r = await mount();
    const answer = r.bridge.handleRequest("ui/showMessage", {
      extension: "openmind-samples.sample-command",
      severity: "info",
      message: "Hello from the sample command extension",
      items: ["OK"],
    });
    expect(await screen.findByText(/Hello from the sample command extension/)).toBeTruthy();
    fireEvent.click(
      within(screen.getByLabelText("Extension messages")).getByRole("button", { name: "OK" }),
    );
    await expect(answer).resolves.toBe("OK");
  });

  const RISKY = testExtension({
    permissions: {
      requested: ["network"],
      inferred: ["commands"],
      accepted: ["commands", "network"],
      highRisk: ["network"],
    },
  });

  it("shows name, publisher, version and the permissions (high risk marked) before installing", async () => {
    const r = await mount();
    vi.mocked(r.ipc.extPickVsix).mockResolvedValue("C:/My Downloads/risky.vsix");
    vi.mocked(r.ipc.extInspectVsix).mockResolvedValue(RISKY);
    fireEvent.click(menuItem(await openMenu("More Actions"), "Install from VSIX..."));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("openmind-samples")).toBeTruthy();
    expect(within(dialog).getByText("1.0.0")).toBeTruthy();
    const permissions = within(dialog).getByLabelText("Permissions");
    expect(within(permissions).getByText("Network")).toBeTruthy();
    expect(within(permissions).getByText("High risk")).toBeTruthy();
    expect(within(permissions).getByText("Commands")).toBeTruthy();
    expect(within(dialog).getByText(/not a sandbox/)).toBeTruthy();
    expect(vi.mocked(r.ipc.extInstall)).not.toHaveBeenCalled();
  });

  it("the Features tab shows granted permissions, activations, host status and last error", async () => {
    await mount([RISKY], {
      node: { portable: true, system: null, allowSystem: false },
      host: { state: "running", pid: 4, node: "OpenMind portable Node.js", error: null },
      activity: {
        [RISKY.id]: {
          active: true,
          lastError: "Command x failed: boom",
          activationCount: 3,
          lastActivation: "2026-09-25 10:00:00",
        },
      },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Sample Command, openmind-samples" }),
    );
    const page = await screen.findByLabelText("Extension: Sample Command", { selector: "section" });
    fireEvent.click(within(page).getByRole("tab", { name: "Features" }));
    const details = within(page).getByLabelText("Sample Command details", { selector: "section" });
    const permissions = within(details).getByLabelText("Permissions");
    expect(within(permissions).getAllByText(/granted/).length).toBe(2);
    expect(within(details).getByText("3")).toBeTruthy();
    expect(within(details).getByText("2026-09-25 10:00:00")).toBeTruthy();
    expect(within(details).getByText("Running (OpenMind portable Node.js)")).toBeTruthy();
    expect(within(details).getByText("Command x failed: boom")).toBeTruthy();
  });

  it("shows the host status line and a crashed host with its restart action", async () => {
    await mount([command], {
      node: { portable: true, system: null, allowSystem: false },
      host: { state: "crashed", pid: null, node: null, error: "It died." },
    });
    expect((await screen.findByLabelText("Extension host status")).textContent).toContain(
      "Stopped unexpectedly: It died.",
    );
    expect(screen.getByRole("button", { name: "Restart Extension Host" })).toBeTruthy();
  });
});
