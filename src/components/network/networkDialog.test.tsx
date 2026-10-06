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
import { preloadLanguages } from "../../testUtils/languages";

preloadLanguages("ru", "bn");

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
  credentialStatus: "saved",
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
    networkTerminalEnv: vi.fn().mockResolvedValue([["PIP_INDEX_URL", "http://127.0.0.1:4000/****/pypi/simple/"]]),
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

  it("Test shows the categorized result; the terminal package settings are shown with the token hidden", async () => {
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
      fireEvent.click(screen.getByRole("button", { name: "Network: Show Terminal Package Settings" }));
      await Promise.resolve();
    });
    expect(screen.getByLabelText("Network: Show Terminal Package Settings")).toHaveTextContent(
      "PIP_INDEX_URL=http://127.0.0.1:4000/****/pypi/simple/",
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

  it("the pip card says it isn't a missing package; Open New Terminal opens one", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Open New Terminal" }));
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
    expect(screen.getByRole("status")).toHaveTextContent("Package settings changed. Open a new terminal to apply them.");
    fireEvent.click(screen.getByRole("button", { name: "Open New Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart This Terminal" }));
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

describe("Milestone 22.3: saved credentials that can't be read", () => {
  const UNREADABLE: NetworkStatus = {
    ...STATUS,
    hasCredentials: false,
    credentialStatus: "unreadable",
    username: null,
    credentialProblem: "Windows couldn't decrypt the stored value (it was saved by another Windows user or machine): error 87",
    diagnostics: [{ severity: "warning", kind: "credentialsUnreadable", inUse: true }],
  };
  const NONE: NetworkStatus = {
    ...STATUS,
    hasCredentials: false,
    credentialStatus: "none",
    username: null,
    diagnostics: [{ severity: "info", kind: "noCredentials" }],
  };

  it("shows the warning, keeps the reason under Details, and lets Clear remove the damaged record", async () => {
    const clear = vi.fn().mockResolvedValue(NONE);
    const r = setup(UNREADABLE, { networkClearCredentials: clear });
    render(<NetworkDialog />);
    await act(() => r.network.openWindow());
    const message = "Saved proxy credentials could not be read. Clear them or save them again.";
    expect(screen.getByRole("region", { name: "Diagnostics" })).toHaveTextContent(message);
    // The raw reason is only under Details, and nothing stored is shown.
    expect(screen.getByText(/error 87/).closest("details")).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/dpapi1|AAAA/);
    const button = screen.getByRole("button", { name: "Clear Credentials" });
    expect(button).toBeEnabled();
    // Saving over it stays possible too.
    fireEvent.change(screen.getByLabelText("User name"), { target: { value: "ivan" } });
    expect(screen.getByRole("button", { name: "Save Credentials" })).toBeEnabled();
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(clear).toHaveBeenCalledOnce();
    expect(screen.queryByText(message)).toBeNull();
    expect(screen.getByRole("region", { name: "Diagnostics" })).toHaveTextContent("No proxy user name and password are saved.");
    expect(screen.getByRole("button", { name: "Clear Credentials" })).toBeDisabled();
  });

  it("Clear stays disabled when nothing is saved, and is enabled for readable credentials", async () => {
    const none = setup(NONE);
    const { unmount } = render(<NetworkDialog />);
    await act(() => none.network.openWindow());
    expect(screen.getByRole("button", { name: "Clear Credentials" })).toBeDisabled();
    unmount();
    const saved = setup(STATUS);
    render(<NetworkDialog />);
    await act(() => saved.network.openWindow());
    expect(screen.getByRole("button", { name: "Clear Credentials" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Diagnostics" })).toBeNull();
  });

  it("saving again overwrites the damaged record and the warning goes away", async () => {
    const save = vi.fn().mockResolvedValue(STATUS);
    const r = setup(UNREADABLE, { networkSetCredentials: save });
    render(<NetworkDialog />);
    await act(() => r.network.openWindow());
    fireEvent.change(screen.getByLabelText("User name"), { target: { value: "ivan" } });
    fireEvent.change(screen.getByLabelText("Password or token"), { target: { value: "Pa$$w0rd!" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save Credentials" }));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith("ivan", "Pa$$w0rd!");
    expect(screen.queryByText("Saved proxy credentials could not be read. Clear them or save them again.")).toBeNull();
    expect(screen.getByText("Saved for ivan.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("w0rd");
  });

  it("the warning in Russian and Bangla", async () => {
    const r = setup(UNREADABLE);
    i18n.setLanguage("ru");
    const { unmount } = render(<NetworkDialog />);
    await act(() => r.network.openWindow());
    expect(screen.getByRole("region", { name: "Диагностика" })).toHaveTextContent(
      "Сохранённые учётные данные прокси не удалось прочитать. Удалите их или сохраните снова.",
    );
    unmount();
    i18n.setLanguage("bn");
    render(<NetworkDialog />);
    expect(screen.getByRole("region", { name: "ডায়াগনস্টিক" })).toHaveTextContent(
      "সংরক্ষিত প্রক্সি লগইন তথ্য পড়া যায়নি। সেগুলো মুছুন অথবা আবার সংরক্ষণ করুন।",
    );
  });
});


describe("Downloads tab (Milestone 23)", () => {
  it("shows the gateway, the tools left on their own settings, the downloads with Cancel, and saves diagnostics", async () => {
    const r = setup();
    const brokerIpc = {
      brokerStatus: vi.fn().mockResolvedValue({
        enabled: true,
        running: true,
        problem: null,
        port: 4000,
        npmPort: 4001,
        tempDir: "C:/app/temp",
        shimsDir: "C:/app/shims",
        skipped: [{ tool: "go", reason: "GOPROXY is set" }],
        recent: [
          {
            id: 3,
            provider: "npm",
            artifact: "express-4.21.2.tgz",
            phase: "downloading",
            bytes: 50_000,
            total: 100_000,
            speed: 10_000,
            retry: 2,
            failure: null,
            detail: null,
          },
        ],
        recovery: { removed: 1, keptPartial: 0, inUse: 0 },
      }),
      brokerCancel: vi.fn().mockResolvedValue(true),
      brokerClearTemp: vi.fn().mockResolvedValue({ removed: 0, keptPartial: 0, inUse: 0 }),
      exportDiagnostics: vi.fn().mockResolvedValue("C:/app/logs/openmind-network-diagnostics.json"),
      onProgress: vi.fn().mockResolvedValue(() => undefined),
    };
    (r.network as unknown as { host: { broker: unknown } }).host.broker = brokerIpc;
    render(<NetworkDialog />);
    await act(() => r.network.openWindow("downloads"));
    expect(screen.getByText("Package gateway running on 127.0.0.1 (port 4000, npm 4001).")).toBeInTheDocument();
    expect(screen.getByText("go: GOPROXY is set")).toBeInTheDocument();
    expect(screen.getByText("npm · express-4.21.2.tgz")).toBeInTheDocument();
    expect(screen.getByText(/Downloading · 48\.8 KB \/ 97\.7 KB · 50% · 9\.8 KB\/s · attempt 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(brokerIpc.brokerCancel).toHaveBeenCalledWith(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save Network Diagnostics" }));
      await Promise.resolve();
    });
    expect(brokerIpc.exportDiagnostics).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Clear Finished" })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear Temporary Files" }));
      await Promise.resolve();
    });
    expect(brokerIpc.brokerClearTemp).toHaveBeenCalled();
    act(() => {
      r.network.onDownload({ ...EVENT_FAILED });
    });
    expect(screen.getByRole("button", { name: "Copy Error Details" })).toBeInTheDocument();
    expect(screen.getByText(/Run the command again to retry/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Finished" })).toBeEnabled();
  });
});

const EVENT_FAILED = {
  id: 4,
  provider: "pypi" as const,
  artifact: "six.whl",
  phase: "failed" as const,
  bytes: 0,
  total: null,
  speed: 0,
  retry: null,
  failure: "timeout" as const,
  detail: "timed out",
};
