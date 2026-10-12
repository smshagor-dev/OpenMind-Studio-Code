import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UpdateInfo, UpdateIpc } from "../../services/updates/updateIpc";
import { UpdateService } from "../../services/updates/updateService";

const holder = vi.hoisted((): { service: UpdateService | null } => ({ service: null }));
vi.mock("../../services/updates", () => ({
  get updates() {
    return holder.service;
  },
}));

import { MandatoryUpdateOverlay } from "./MandatoryUpdateOverlay";
import { UpdateDialog } from "./UpdateDialog";
import { UpdateStatusItem } from "./UpdateStatusItem";

function info(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: "1.0.2",
    available: true,
    version: "1.1.0",
    notes: "Fixes.",
    date: null,
    install: "nsis",
    mode: { kind: "installer" },
    phase: "ready",
    mandatory: false,
    ready: true,
    installOnExit: true,
    automatic: true,
    downloaded: 0,
    total: null,
    failure: null,
    lastChecked: null,
    releasesPage: "https://github.com/smshagor-dev/OpenMind-Studio/releases/latest",
    activity: { unsaved: 0, terminals: 0, busyTerminals: 0, runs: 0 },
    ...overrides,
  };
}

async function serviceWith(state: UpdateInfo): Promise<{ service: UpdateService; ipc: UpdateIpc }> {
  const ipc: UpdateIpc = {
    status: vi.fn(() => Promise.resolve(state)),
    check: vi.fn(() => Promise.resolve(state)),
    download: vi.fn(() => Promise.resolve(state)),
    installNow: vi.fn(() => Promise.resolve()),
    setInstallOnExit: vi.fn(() => Promise.resolve()),
    reportUnsaved: vi.fn(() => Promise.resolve()),
    onState: vi.fn(() => Promise.resolve(() => undefined)),
    onProgress: vi.fn(() => Promise.resolve(() => undefined)),
  };
  const service = new UpdateService(ipc, {
    unsavedCount: () => state.activity.unsaved,
    onUnsavedChange: () => () => undefined,
    saveAll: vi.fn(() => Promise.resolve()),
    confirm: vi.fn(() => Promise.resolve(true)),
    notify: vi.fn(),
    text: (key) => key,
    openExternal: vi.fn(() => Promise.resolve()),
  });
  holder.service = service;
  await act(async () => {
    await service.start();
  });
  return { service, ipc };
}

afterEach(cleanup);

describe("update UI", () => {
  it("the status bar offers the restart, and the dialog installs on request", async () => {
    const { ipc } = await serviceWith(info());
    render(
      <>
        <UpdateStatusItem />
        <UpdateDialog />
      </>,
    );
    fireEvent.click(screen.getByText(/Restart to update \(1\.1\.0\)/));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/downloaded and verified/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restart to Update" }));
      await Promise.resolve();
    });
    expect(ipc.installNow).toHaveBeenCalledWith(false);
  });

  it("nothing shows while up to date", async () => {
    await serviceWith(info({ available: false, version: null, phase: "upToDate", ready: false }));
    const { container } = render(<UpdateStatusItem />);
    expect(container.textContent).toBe("");
  });

  it("a mandatory update blocks work with Save All first, and Restart stays disabled while editors are unsaved", async () => {
    await serviceWith(info({ mandatory: true, activity: { unsaved: 2, terminals: 0, busyTerminals: 0, runs: 0 } }));
    render(<MandatoryUpdateOverlay />);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/no longer supported/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save All" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Restart to Update" }).disabled).toBe(true);
  });

  it("a mandatory update that isn't downloaded never blocks", async () => {
    await serviceWith(info({ mandatory: true, ready: false, phase: "available" }));
    const { container } = render(<MandatoryUpdateOverlay />);
    expect(container.textContent).toBe("");
  });
});
