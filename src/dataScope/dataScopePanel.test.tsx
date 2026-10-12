import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DataScopePanel } from "./DataScopePanel";
import { DataScopeSetupPage } from "./DataScopeSetupPage";
import { DataScopeDialog } from "./DataScopeDialog";
import { DataScopeDialogService, wireDataScope } from "./dataScopeDialogService";
import type { DataScopeApi, DataScopeStatus, MigrationOutcome } from "./dataScopeApi";
import { CommandRegistry } from "../services/commandRegistry";

const LEGACY = "G:/OpenMind-Studio/data/openmind-studio.db";

function status(overrides: Partial<DataScopeStatus> = {}): DataScopeStatus {
  return {
    mode: null,
    recommended: "perMachine",
    profileId: "42f693bd91a7",
    identitySource: "system",
    appFolder: "G:/OpenMind-Studio",
    sharedDatabase: null,
    machineDatabase: null,
    profiles: [],
    unreadable: null,
    singleComputer: false,
    layout: "portable",
    managed: false,
    localFolder: null,
    temporaryFolder: false,
    ...overrides,
  };
}

function fakeApi(current: DataScopeStatus, outcome?: Partial<MigrationOutcome>) {
  const api = {
    status: vi.fn(() => Promise.resolve(current)),
    apply: vi.fn(() =>
      Promise.resolve<MigrationOutcome>({
        database: "G:/OpenMind-Studio/data/machines/42f693bd91a7/openmind-studio.db",
        keptExisting: false,
        willImport: false,
        ...outcome,
      }),
    ),
    restart: vi.fn(() => Promise.resolve()),
    exit: vi.fn(() => Promise.resolve()),
  } satisfies DataScopeApi;
  return api;
}

describe("DataScopePanel", () => {
  it("offers both choices with the multi-computer one recommended and preselected", async () => {
    render(<DataScopeSetupPage api={fakeApi(status())} />);
    await screen.findByText("All users / Multi-computer");
    expect(screen.getByText("Only for me")).toBeTruthy();
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.getByText(/Your runtimes and Language Tools stay shared/)).toBeTruthy();
    // The badge sits on the multi-computer option, not on "Only for me".
    const recommended = screen.getByText("Recommended").closest("label");
    expect(recommended?.querySelector<HTMLInputElement>("input")?.value).toBe("perMachine");
    const radios = screen.getAllByRole<HTMLInputElement>("radio");
    expect(radios.find((radio) => radio.checked)?.value).toBe("perMachine");
    expect(screen.getByText(/This computer's profile: 42f693bd91a7/)).toBeTruthy();
  });

  it("offers to copy an existing profile, warns, and applies the copy only when asked", async () => {
    const api = fakeApi(status({ sharedDatabase: { path: LEGACY, bytes: 2048 } }), { willImport: true });
    render(<DataScopePanel api={api} context="setup" />);
    await screen.findByText(`Existing data found: ${LEGACY} (2 KB).`);
    expect(screen.getByText(/The current data is never deleted/)).toBeTruthy();
    const keep = screen.getByRole<HTMLInputElement>("checkbox");
    expect(keep.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/At the next start the profile is copied to .* and checked/);
    expect(api.apply).toHaveBeenCalledWith("perMachine", true);
    fireEvent.click(screen.getByRole("button", { name: "Start OpenMind Studio" }));
    expect(api.restart).toHaveBeenCalled();
  });

  it("starts fresh when the copy is unticked", async () => {
    const api = fakeApi(status({ sharedDatabase: { path: LEGACY, bytes: 10 } }));
    render(<DataScopePanel api={api} context="setup" />);
    fireEvent.click(await screen.findByRole("checkbox"));
    expect(screen.getAllByText(/starts with a new, empty profile/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(api.apply).toHaveBeenCalledWith("perMachine", false);
    });
  });

  it("says an existing target profile is used as it is", async () => {
    const machine = "G:/OpenMind-Studio/data/machines/42f693bd91a7/openmind-studio.db";
    render(
      <DataScopePanel
        api={fakeApi(status({ sharedDatabase: { path: LEGACY, bytes: 1 }, machineDatabase: { path: machine, bytes: 1 } }))}
        context="setup"
      />,
    );
    await screen.findByText(new RegExp(`already exists \\(${machine}\\)`));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("in the workbench, the scope in use can't be applied again and a failure is shown", async () => {
    const api = fakeApi(status({ mode: "perMachine", machineDatabase: { path: "m.db", bytes: 1 } }));
    api.apply.mockImplementationOnce(() => Promise.reject(new Error("Stop the PHP and MySQL servers first")));
    render(<DataScopePanel api={api} context="workbench" onClose={() => undefined} />);
    await screen.findByText("This is the data scope in use.");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Only for me/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByText(/Stop the PHP and MySQL servers first/);
    expect(api.apply).toHaveBeenCalledWith("personal", true);
  });

  it("shows an unreadable choice and lets the setup exit", async () => {
    const api = fakeApi(status({ unreadable: "expected value at line 1" }));
    render(<DataScopePanel api={api} context="setup" />);
    await screen.findByText(/couldn't be read \(expected value at line 1\)/);
    fireEvent.click(screen.getByRole("button", { name: "Exit" }));
    expect(api.exit).toHaveBeenCalled();
  });
});

describe("Data Scope dialog", () => {
  it("opens from preferences.dataScope and closes with Escape", async () => {
    const commands = new CommandRegistry();
    const service = wireDataScope(commands);
    render(<DataScopeDialog service={service} api={fakeApi(status({ mode: "personal" }))} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await commands.execute("preferences.dataScope");
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("notifies only on a real change", () => {
    const service = new DataScopeDialogService();
    const listener = vi.fn();
    service.subscribe(listener);
    service.close();
    service.show();
    service.show();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.isOpen()).toBe(true);
  });

  it("shows an installer-managed installation without any choice to make", async () => {
    const api = fakeApi(
      status({
        mode: "perMachine",
        layout: "network",
        managed: true,
        appFolder: "//lab-server/apps/OpenMind Studio",
        localFolder: "C:/Users/ana/AppData/Local/OpenMind/Studio/Installations/0123456789abcdef",
      }),
    );
    render(<DataScopePanel api={api} context="workbench" onClose={vi.fn()} />);
    await screen.findByText(/network installation for all connected computers/);
    expect(screen.getByText(/lab-server/)).toBeTruthy();
    expect(screen.getByText(/0123456789abcdef/)).toBeTruthy();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByText("Apply")).toBeNull();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("warns before anything is chosen when the program runs from a temporary folder", async () => {
    render(
      <DataScopeSetupPage
        api={fakeApi(status({ temporaryFolder: true, appFolder: "C:/Users/x/AppData/Local/Temp/Temp1_om.zip" }))}
      />,
    );
    const alert = await screen.findByText(/running from a temporary folder/);
    expect(alert.textContent).toContain("Temp1_om.zip");
    expect(alert.textContent).toContain("extract the ZIP");
  });
});
