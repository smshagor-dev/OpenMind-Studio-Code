import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { command, type Rig, rig } from "../testUtils/extensionRig";
import { emptyExtensionsSnapshot, testExtension } from "../testUtils/fakeExtensionsIpc";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));

vi.mock("../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { ExtensionPrompts } from "./ExtensionPrompts";
import { ExtensionsView } from "./ExtensionsView";

async function mount(
  extensions = [] as ReturnType<typeof testExtension>[],
  overrides: Parameters<typeof rig>[1] = {},
): Promise<Rig> {
  const r = rig(extensions, overrides);
  harness.current = {
    extensions: {
      registry: r.registry,
      service: r.service,
      host: r.host,
      marketplace: r.marketplace,
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
      <ExtensionPrompts />
    </>,
  );
  return r;
}

beforeEach(() => {
  harness.current = null;
});

describe("ExtensionsView", () => {
  it("shows an empty state, no fake marketplace and the install button", async () => {
    await mount();
    expect(await screen.findByText("No extensions are installed.")).toBeTruthy();
    expect(screen.getByLabelText("Marketplace").textContent).toBe(
      "Online extension marketplace is not available yet.",
    );
    expect(screen.getByRole("button", { name: "Install from VSIX…" })).toBeTruthy();
    // Nothing that looks like a marketplace search or an install-from-store action.
    expect(screen.queryByPlaceholderText(/marketplace/i)).toBeNull();
    // "Reload Extension Host" is disabled with its reason while there is nothing to run.
    const reload = screen.getByRole("button", { name: "Reload Extension Host" });
    expect((reload as HTMLButtonElement).disabled).toBe(true);
    expect(reload.getAttribute("title")).toBe("No installed extension has code to run.");
  });

  it("lists installed extensions, searches them and shows their state", async () => {
    const other = testExtension({
      enabled: false,
      manifest: { ...command.manifest, name: "other", displayName: "Zebra Tools" },
    });
    await mount([command, other], { node: { portable: true, system: null, allowSystem: false } });
    const list = await screen.findByLabelText("Installed extensions");
    expect(within(list).getByText("Sample Command")).toBeTruthy();
    expect(within(list).getByText("Zebra Tools")).toBeTruthy();
    expect(within(list).getByText("Disabled")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search installed extensions"), { target: { value: "zebra" } });
    expect(within(screen.getByLabelText("Installed extensions")).queryByText("Sample Command")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search installed extensions"), { target: { value: "zzz" } });
    expect(await screen.findByText("No installed extension matches “zzz”.")).toBeTruthy();
  });

  it("shows the details, including unsupported contribution points", async () => {
    const extension = testExtension({
      warnings: ["Activates at every start-up (\"*\"), which can slow the app down."],
      activationEvents: ["onCommand:sampleCommand.hello", "*"],
      points: [
        { point: "commands", count: 1, support: "supported", note: null },
        { point: "viewsContainers", count: 1, support: "unsupported", note: null },
      ],
    });
    await mount([extension], { node: { portable: true, system: null, allowSystem: false } });
    fireEvent.click(await screen.findByRole("button", { name: "Sample Command details" }));
    const details = screen.getByLabelText("Sample Command details", { selector: "section" });
    expect(within(details).getByText("openmind-samples")).toBeTruthy();
    expect(within(details).getByText(extension.path)).toBeTruthy();
    expect(within(details).getByText(/Node.js runtime is required for extension host./)).toBeTruthy();
    expect(within(details).getByText('When the command "sampleCommand.hello" runs')).toBeTruthy();
    expect(within(details).getAllByText(/slow the app down/).length).toBe(2);
    const points = within(details).getByLabelText("Contribution points");
    expect(within(points).getByText(/This contribution point is not supported yet./)).toBeTruthy();
    expect(within(details).getByText(/OpenMind Studio supports a VS Code API subset/)).toBeTruthy();
  });

  it("asks for confirmation with the trust warning before installing a .vsix", async () => {
    const r = await mount();
    (r.ipc.extPickVsix as ReturnType<typeof vi.fn>).mockResolvedValue("C:/My Downloads/sample.vsix");
    (r.ipc.extInspectVsix as ReturnType<typeof vi.fn>).mockResolvedValue(command);
    fireEvent.click(screen.getByRole("button", { name: "Install from VSIX…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Extensions can run code on your computer. Install only from trusted sources.")).toBeTruthy();
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
    (r.ipc.extPickVsix as ReturnType<typeof vi.fn>).mockResolvedValue("C:/a.vsix");
    fireEvent.click(screen.getByRole("button", { name: "Install from VSIX…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(r.ipc.extInstall).not.toHaveBeenCalled();
  });

  it("disables, enables and uninstalls (after a confirmation)", async () => {
    const r = await mount([command], { node: { portable: true, system: null, allowSystem: false } });
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    await waitFor(() => {
      expect(r.ipc.extSetEnabled).toHaveBeenCalledWith(command.id, false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(r.ipc.extUninstall).not.toHaveBeenCalled();
    r.snapshot.current = emptyExtensionsSnapshot();
    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    await waitFor(() => {
      expect(r.ipc.extUninstall).toHaveBeenCalledWith(command.id);
    });
    expect(await screen.findByText("No extensions are installed.")).toBeTruthy();
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
      host: { state: "crashed", pid: null, node: null, error: "The extension host stopped unexpectedly." },
      activity: { [command.id]: { active: false, lastError: "Activating a.b failed: boom" } },
    });
    expect(await screen.findByText("The extension host stopped unexpectedly.")).toBeTruthy();
    const status = screen.getByText("Error");
    expect(status.getAttribute("title")).toBe("Activating a.b failed: boom");
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
    fireEvent.click(within(screen.getByLabelText("Extension messages")).getByRole("button", { name: "OK" }));
    await expect(answer).resolves.toBe("OK");
  });
});
