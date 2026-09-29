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

import { NetworkDialog, NetworkFailureCard, NetworkStatusButton, StaleTerminalBanner } from "./NetworkDialog";

const STATUS: NetworkStatus = {
  mode: "manual",
  source: "manual",
  active: true,
  http: "http://proxy.lab:3128",
  https: "http://proxy.lab:3128",
  socks: null,
  noProxy: ["localhost"],
  pacUrl: null,
  diagnostics: [],
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
  const terminals = {
    openProxyReady: vi.fn().mockResolvedValue(null),
    restart: vi.fn().mockResolvedValue(null),
    runInNewTerminal: vi.fn().mockResolvedValue(null),
  };
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
    terminals,
  });
  const run = vi.fn();
  const terminalState: { activeId: string | null } = { activeId: null };
  const terminal = { subscribe: () => () => undefined, getState: () => terminalState };
  harness.current = { network, run, terminal, settings: { string: () => "" } };
  return { network, setSetting, run, ipc: full, terminals, terminalState };
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
    expect(screen.getByRole("status")).toHaveTextContent("✓ Connected");
    expect(screen.getByText("through proxy.lab:3128 · HTTP 200 · 40 ms")).toBeInTheDocument();
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
  it("offers Configure Proxy, Retry, Import Wheels / Offline Package and Use Offline Cache", () => {
    const r = setup();
    const retry = vi.fn();
    act(() => {
      r.network.report("npm ERR! code E407", "Tasks", retry);
    });
    render(<NetworkFailureCard />);
    expect(screen.getByRole("alert")).toHaveTextContent("Tasks: the proxy requires a user name and password.");
    for (const name of ["Configure Proxy", "Import Wheels / Offline Package", "Use Offline Cache"]) {
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

describe("Milestone 22.2: diagnostics, Test Connection labels, pip, stale terminals, wheelhouse", () => {
  it("shows what the backend ignores, e.g. an HTTPS address with credentials from settings.json", async () => {
    const r = setup({
      ...STATUS,
      hasCredentials: false,
      username: null,
      diagnostics: [
        { severity: "warning", kind: "ignoredField", field: "https", problem: "credentialsInAddress" },
        { severity: "info", kind: "noCredentials" },
      ],
    });
    render(<NetworkDialog />);
    await act(() => r.network.openWindow());
    const section = screen.getByRole("region", { name: "Diagnostics" });
    expect(section).toHaveTextContent(
      "HTTPS proxy is ignored because it contains credentials in the URL. Store credentials in the secure username/password fields instead.",
    );
    expect(section).toHaveTextContent("No proxy user name and password are saved.");
    // Stale terminals are mentioned there too.
    act(() => {
      r.network.setStaleTerminals(["t1"]);
    });
    expect(section).toHaveTextContent("Some open terminals still use the old proxy settings.");
  });

  it("no Diagnostics section when there is nothing to say", async () => {
    const r = setup();
    render(<NetworkDialog />);
    await act(() => r.network.openWindow());
    expect(screen.queryByRole("region", { name: "Diagnostics" })).toBeNull();
  });

  it("a failed test leads with an actionable label, a hint, and the raw error under Details", async () => {
    const r = setup(STATUS, {
      networkTest: vi.fn().mockResolvedValue({
        ok: false,
        problem: "dns",
        status: null,
        route: "direct",
        proxy: null,
        elapsedMs: 8,
        detail: "io: No such host is known. (os error 11001)",
      }),
    });
    render(<NetworkDialog />);
    await act(() => r.network.openWindow());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test" }));
      await Promise.resolve();
    });
    const result = screen.getByRole("status");
    expect(result).toHaveTextContent("✗ DNS lookup failed");
    expect(result).toHaveTextContent("directly · 8 ms");
    expect(result).toHaveTextContent("This computer couldn't resolve the name.");
    expect(result).not.toHaveTextContent("reading from the network failed");
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("io: No such host is known. (os error 11001)")).toBeInTheDocument();
  });

  it("the pip card says it isn't a missing package; Open New Proxy-Ready Terminal opens one", async () => {
    const r = setup();
    act(() => {
      r.network.report(
        "OSError('Tunnel connection failed: 407 Proxy Authentication Required')\nERROR: No matching distribution found for django",
        "Terminal",
        null,
        true,
      );
    });
    render(<NetworkFailureCard />);
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent(
      "Terminal: pip could not reach PyPI because the network proxy requires authentication. This is not a missing Python package.",
    );
    expect(card).toHaveTextContent("This looks like a proxy authentication problem, not a missing Python package.");
    fireEvent.click(screen.getByRole("button", { name: "Open New Proxy-Ready Terminal" }));
    await act(() => Promise.resolve());
    expect(r.terminals.openProxyReady).toHaveBeenCalledWith(null);
  });

  it("the pip card in Russian and Bangla", () => {
    const r = setup();
    act(() => {
      r.network.report("407 Proxy Authentication Required /simple/pandas/", "Terminal", null, true);
    });
    i18n.setLanguage("ru");
    const { unmount } = render(<NetworkFailureCard />);
    expect(screen.getByRole("alert")).toHaveTextContent("Это не отсутствующий пакет Python.");
    expect(screen.getByRole("button", { name: "Импортировать колёса / офлайн-пакет" })).toBeInTheDocument();
    unmount();
    i18n.setLanguage("bn");
    render(<NetworkFailureCard />);
    expect(screen.getByRole("alert")).toHaveTextContent("এটি কোনো অনুপস্থিত Python প্যাকেজ নয়।");
  });

  it("a stale terminal gets the banner with Open New, Restart and Keep", async () => {
    const r = setup();
    r.terminalState.activeId = "t1";
    render(<StaleTerminalBanner />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      r.network.setStaleTerminals(["t1"]);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Proxy settings changed. Open a new terminal to apply them.");
    fireEvent.click(screen.getByRole("button", { name: "Open New Proxy-Ready Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart This Terminal With Proxy" }));
    await act(() => Promise.resolve());
    expect(r.terminals.openProxyReady).toHaveBeenCalledWith("t1");
    expect(r.terminals.restart).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByRole("button", { name: "Keep Current Terminal" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the wheelhouse lists recognized packages and refused wheels, and installs with --no-index", async () => {
    const django = {
      id: "w1",
      kind: "wheel" as const,
      name: "Django",
      version: "5.2",
      architecture: "any",
      sha256: "c".repeat(64),
      size: 1,
      file: "offline/wheels/Django-5.2-py3-none-any.whl",
      importedAt: 0,
      source: "localImport",
      runtime: null,
    };
    const wheelhouseCommand = vi.fn().mockResolvedValue(["python", "-m", "pip", "install", "--no-index", "--find-links=file:///C:/w", "django"]);
    const r = setup(STATUS, {
      wheelhouse: vi.fn().mockResolvedValue({ folder: "C:/w", url: "file:///C:/w", wheels: [django] }),
      wheelhouseCommand,
    });
    render(<NetworkDialog />);
    await act(() => r.network.openWindow("offline"));
    const section = screen.getByRole("region", { name: "Python wheelhouse" });
    expect(section).toHaveTextContent("--no-index");
    expect(screen.getByRole("list", { name: "Recognized packages" })).toHaveTextContent("Django 5.2");
    const install = screen.getByRole("button", { name: "Install from Wheelhouse" });
    expect(install).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Packages to install"), { target: { value: "django" } });
    await act(async () => {
      fireEvent.click(install);
      await Promise.resolve();
    });
    expect(wheelhouseCommand).toHaveBeenCalledWith("django");
    expect(r.terminals.runInNewTerminal).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Import Wheels Folder..." })).toBeInTheDocument();
  });
});
