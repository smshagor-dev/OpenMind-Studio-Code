import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { i18n } from "../../i18n";
import { EventBus } from "../../services/eventBus";
import type { AppEvents } from "../../services/events";
import type { NetworkIpc, NetworkStatus } from "../../services/network/networkIpc";
import { NetworkService } from "../../services/network/networkService";

const harness = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("../../services/container", () => ({
  get container() {
    return harness.current;
  },
}));

import { NetworkDialog, NetworkFailureCard, NetworkStatusButton } from "./NetworkDialog";

const STATUS: NetworkStatus = {
  mode: "manual",
  source: "manual",
  active: true,
  http: "http://proxy.lab:3128",
  https: "http://proxy.lab:3128",
  socks: null,
  noProxy: ["localhost"],
  pacUrl: null,
  problems: [],
  hasCredentials: true,
  username: "ivan",
  credentialProblem: null,
  useWheelhouse: false,
  goProxy: null,
  testUrl: "https://pypi.org/",
};

function setup(status: NetworkStatus = STATUS, ipc: Partial<NetworkIpc> = {}) {
  const setSetting = vi.fn().mockResolvedValue(null);
  const full = {
    networkStatus: vi.fn().mockResolvedValue(status),
    offlineList: vi.fn().mockResolvedValue([]),
    networkTest: vi.fn().mockResolvedValue({
      ok: true,
      problem: null,
      status: 200,
      route: "proxy",
      proxy: "proxy.lab:3128",
      elapsedMs: 40,
      detail: null,
    }),
    networkTerminalEnv: vi.fn().mockResolvedValue([["HTTPS_PROXY", "http://ivan:****@proxy.lab:3128"]]),
    offlineInspect: vi.fn().mockResolvedValue({
      path: "E:/usb/numpy-2.0.0-cp312-cp312-manylinux_2_17_x86_64.whl",
      fileName: "numpy-2.0.0-cp312-cp312-manylinux_2_17_x86_64.whl",
      kind: "wheel",
      name: "numpy",
      version: "2.0.0",
      architecture: "manylinux_2_17_x86_64",
      compatible: false,
      sha256: "b".repeat(64),
      size: 5_000_000,
      reason: "This wheel is for manylinux_2_17_x86_64; Windows x64 needs win_amd64 or any.",
      runtime: null,
    }),
    ...ipc,
  } as unknown as NetworkIpc;
  const network = new NetworkService({
    ipc: full,
    events: new EventBus<AppEvents>(),
    settingValue: () => "",
    setSetting,
    pickFile: () => Promise.resolve("E:/usb/numpy.whl"),
    pickFolder: () => Promise.resolve(null),
    openFolder: () => Promise.resolve(),
    installVsix: () => Promise.resolve(),
    openRuntimeManager: () => undefined,
  });
  const run = vi.fn();
  harness.current = { network, run, settings: { string: () => "" } };
  return { network, setSetting, run, ipc: full };
}

afterEach(() => {
  cleanup();
  i18n.setLanguage("en");
  harness.current = null;
});

describe("NetworkDialog", () => {
  it("shows the three modes and, in Manual, the address fields with validation", async () => {
    const r = setup();
    render(<NetworkDialog />);
    await act(() => r.network.openWindow());
    expect(screen.getByRole("radio", { name: "Manual Proxy" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "No Proxy" })).toBeInTheDocument();
    const http = screen.getByLabelText("HTTP Proxy");
    fireEvent.change(http, { target: { value: "http://ivan:pw@proxy:3128" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/password/);
    fireEvent.blur(http);
    expect(r.setSetting).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Use System Proxy" }));
    await act(() => Promise.resolve());
    expect(r.setSetting).toHaveBeenCalledWith("network.proxy.mode", "system");
  });

  it("the password field is masked and the saved password is never shown", async () => {
    const r = setup();
    render(<NetworkDialog />);
    await act(() => r.network.openWindow());
    expect(screen.getByLabelText("Password or token")).toHaveAttribute("type", "password");
    expect(screen.getByText("Saved for ivan.")).toBeInTheDocument();
  });

  it("Test shows the categorized result; the terminal environment is shown redacted", async () => {
    const r = setup();
    render(<NetworkDialog />);
    await act(() => r.network.openWindow());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test" }));
      await Promise.resolve();
    });
    expect(screen.getByText("Connected through proxy.lab:3128: HTTP 200 in 40 ms.")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Network: Show Current Terminal Proxy Environment" }));
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Network: Show Current Terminal Proxy Environment")).toHaveTextContent(
      "HTTPS_PROXY=http://ivan:****@proxy.lab:3128",
    );
  });

  it("the offline tab refuses a package for another platform, with the reason", async () => {
    const r = setup();
    render(<NetworkDialog />);
    await act(() => r.network.openWindow("offline"));
    expect(screen.getByText("No offline packages yet.")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Network: Import Offline Package" }));
      await Promise.resolve();
    });
    expect(screen.getByText(/Windows x64 needs win_amd64/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it("is translated (Russian)", async () => {
    const r = setup();
    i18n.setLanguage("ru");
    render(<NetworkDialog />);
    await act(() => r.network.openWindow());
    expect(screen.getByRole("heading", { name: "Сеть" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Прокси вручную" })).toBeChecked();
  });
});

describe("NetworkFailureCard and the terminal label", () => {
  it("offers Configure Proxy, Retry, Import Package and Use Offline Cache", () => {
    const r = setup();
    const retry = vi.fn();
    act(() => {
      r.network.report("npm ERR! code E407", "Tasks", retry);
    });
    render(<NetworkFailureCard />);
    expect(screen.getByRole("alert")).toHaveTextContent("Tasks: the proxy requires a user name and password.");
    for (const name of ["Configure Proxy", "Import Package", "Use Offline Cache"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the terminal header names the mode and opens the settings (Bangla)", async () => {
    const r = setup();
    await r.network.load();
    i18n.setLanguage("bn");
    render(<NetworkStatusButton />);
    fireEvent.click(screen.getByRole("button", { name: "নেটওয়ার্ক: ম্যানুয়াল প্রক্সি" }));
    expect(r.run).toHaveBeenCalledWith("network.openSettings");
  });
});
