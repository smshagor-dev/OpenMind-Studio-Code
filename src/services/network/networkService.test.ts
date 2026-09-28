import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { CacheEntry, Inspection, NetworkIpc, NetworkStatus } from "./networkIpc";
import { NetworkService, type NetworkHost } from "./networkService";

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
  hasCredentials: false,
  username: null,
  credentialProblem: null,
  useWheelhouse: false,
  goProxy: null,
  testUrl: "https://pypi.org/",
};

const WHEEL: Inspection = {
  path: "E:/usb/six-1.16.0-py2.py3-none-any.whl",
  fileName: "six-1.16.0-py2.py3-none-any.whl",
  kind: "wheel",
  name: "six",
  version: "1.16.0",
  architecture: "any",
  compatible: true,
  sha256: "a".repeat(64),
  size: 11_000,
  reason: null,
  runtime: null,
};

const entry = (kind: CacheEntry["kind"], id = "e1"): CacheEntry => ({
  id,
  kind,
  name: "six",
  version: "1.16.0",
  architecture: "any",
  sha256: "a".repeat(64),
  size: 1,
  file: "offline/wheels/six.whl",
  importedAt: 0,
  source: "localImport",
  runtime: null,
});

function rig(ipc: Partial<NetworkIpc> = {}, host: Partial<NetworkHost> = {}) {
  const events = new EventBus<AppEvents>();
  const notices: string[] = [];
  events.on("appNotice", ({ message }) => notices.push(message));
  const fullIpc: NetworkIpc = {
    networkStatus: vi.fn().mockResolvedValue(STATUS),
    networkSetCredentials: vi.fn().mockResolvedValue({ ...STATUS, hasCredentials: true, username: "ivan" }),
    networkClearCredentials: vi.fn().mockResolvedValue(STATUS),
    networkTest: vi.fn().mockResolvedValue({
      ok: false,
      problem: "proxyAuthRequired",
      status: 407,
      route: "proxy",
      proxy: "proxy.lab:3128",
      elapsedMs: 5,
      detail: null,
    }),
    networkTerminalEnv: vi.fn().mockResolvedValue([["HTTP_PROXY", "http://ivan:****@proxy.lab:3128"]]),
    offlineInspect: vi.fn().mockResolvedValue(WHEEL),
    offlineImport: vi.fn().mockResolvedValue(entry("wheel")),
    offlineList: vi.fn().mockResolvedValue([]),
    offlineRemove: vi.fn().mockResolvedValue(undefined),
    offlineClear: vi.fn().mockResolvedValue(undefined),
    offlineFolder: vi.fn().mockResolvedValue("C:/app/cache/offline"),
    offlinePath: vi.fn().mockResolvedValue("C:/app/cache/offline/vsix/a.vsix"),
    offlineExtract: vi.fn().mockResolvedValue(3),
    ...ipc,
  };
  let clock = 0;
  const fullHost: NetworkHost = {
    ipc: fullIpc,
    events,
    settingValue: () => "",
    setSetting: vi.fn().mockResolvedValue(null),
    pickFile: vi.fn().mockResolvedValue(WHEEL.path),
    pickFolder: vi.fn().mockResolvedValue("C:/work/empty"),
    openFolder: vi.fn().mockResolvedValue(undefined),
    installVsix: vi.fn().mockResolvedValue(undefined),
    openRuntimeManager: vi.fn(),
    now: () => clock,
    ...host,
  };
  return {
    service: new NetworkService(fullHost),
    ipc: fullIpc,
    host: fullHost,
    notices,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("NetworkService: settings and credentials", () => {
  it("opening the window reads local state only (status and the offline list)", async () => {
    const r = rig();
    await r.service.openWindow();
    expect(r.service.getState().status).toEqual(STATUS);
    expect(r.ipc.networkTest).not.toHaveBeenCalled();
  });

  it("a bad proxy address is refused before anything is saved; a good one is saved and re-read", async () => {
    const r = rig();
    expect(await r.service.saveSetting("network.proxy.http", "http://ivan:pw@proxy:3128")).toBe(false);
    expect(r.host.setSetting).not.toHaveBeenCalled();
    expect(r.service.getState().error).toMatch(/password/);
    expect(await r.service.saveSetting("network.proxy.http", " proxy.lab:3128 ")).toBe(true);
    expect(r.host.setSetting).toHaveBeenCalledWith("network.proxy.http", "proxy.lab:3128");
    expect(r.ipc.networkStatus).toHaveBeenCalled();
  });

  it("only the three proxy address fields are validated as addresses", () => {
    const r = rig();
    expect(r.service.fieldProblem("network.proxy.noProxy", "localhost,127.0.0.1,::1,.local")).toBeNull();
    expect(r.service.fieldProblem("network.goProxy", "https://proxy.golang.org,direct")).toBeNull();
    expect(r.service.fieldProblem("network.proxy.https", "proxy:99999")).toMatch(/65535/);
  });

  it("credentials go to the backend once and are never kept in the service", async () => {
    const r = rig();
    expect(await r.service.saveCredentials("", "x")).toBe(false);
    expect(await r.service.saveCredentials("ivan", "s3cr3t")).toBe(true);
    expect(r.ipc.networkSetCredentials).toHaveBeenCalledWith("ivan", "s3cr3t");
    expect(JSON.stringify(r.service.getState())).not.toContain("s3cr3t");
    expect(r.service.getState().status?.username).toBe("ivan");
    expect(await r.service.clearCredentials()).toBe(true);
    expect(r.service.getState().notice).toBe("Proxy credentials cleared.");
  });

  it("Test shows the running state, then the categorized outcome", async () => {
    const r = rig();
    const pending = r.service.test("https://example.edu/");
    expect(r.service.getState().testing).toBe(true);
    const outcome = await pending;
    expect(r.ipc.networkTest).toHaveBeenCalledWith("https://example.edu/");
    expect(outcome?.problem).toBe("proxyAuthRequired");
    expect(r.service.getState().testing).toBe(false);
    await r.service.test("  ");
    expect(r.ipc.networkTest).toHaveBeenLastCalledWith(null);
  });

  it("the terminal environment is shown as the backend redacted it", async () => {
    const r = rig();
    await r.service.showTerminalEnv();
    expect(r.service.getState().env).toEqual([["HTTP_PROXY", "http://ivan:****@proxy.lab:3128"]]);
  });

  it("the terminal notice appears once per session, and only when a proxy is in force", async () => {
    const off = rig({ networkStatus: vi.fn().mockResolvedValue({ ...STATUS, mode: "none", active: false }) });
    await off.service.load();
    off.service.terminalStarted();
    expect(off.notices).toEqual([]);
    const r = rig();
    await r.service.load();
    r.service.terminalStarted();
    r.service.terminalStarted();
    expect(r.notices).toEqual(["Proxy environment applied to this terminal session."]);
  });
});

describe("NetworkService: failures", () => {
  it("a network problem in a tool's output shows the card; other output doesn't", () => {
    const r = rig();
    expect(r.service.report("Successfully installed six", "Tasks")).toBe(false);
    expect(r.service.report("npm ERR! code E407", "Tasks")).toBe(true);
    expect(r.service.getState().failure?.problem).toBe("proxyAuthRequired");
    const failure = r.service.getState().failure;
    if (failure === null) throw new Error("no failure");
    expect(r.service.failureText(failure)).toBe(
      "Tasks: the proxy requires a user name and password.",
    );
  });

  it("terminal output only counts unmistakable problems", () => {
    const r = rig();
    expect(r.service.report("Request timed out.", "Terminal", null, true)).toBe(false);
    expect(r.service.report("Could not resolve host: pypi.org", "Terminal", null, true)).toBe(true);
  });

  it("a dismissed problem stays quiet for a while; Retry runs the failed action again", () => {
    const r = rig();
    r.service.report("getaddrinfo ENOTFOUND", "Git");
    r.service.dismissFailure();
    expect(r.service.report("getaddrinfo ENOTFOUND", "Git")).toBe(false);
    r.advance(3 * 60 * 1000);
    const retry = vi.fn();
    r.service.report("getaddrinfo ENOTFOUND", "Runtime Manager");
    // The same problem reported with a way to retry gains the Retry button.
    r.service.report("download failed (DNS lookup failed): x", "Runtime Manager", retry);
    r.service.retryFailure();
    expect(retry).toHaveBeenCalledOnce();
    expect(r.service.getState().failure).toBeNull();
  });

  it("Use Offline Cache turns on the offline wheels and opens the offline tab", async () => {
    const r = rig();
    r.service.report("CERTIFICATE_VERIFY_FAILED", "Python");
    await r.service.useOfflineCache();
    expect(r.host.setSetting).toHaveBeenCalledWith("network.offline.useWheelhouse", true);
    expect(r.service.getState()).toMatchObject({ open: true, tab: "offline", failure: null });
  });
});

describe("NetworkService: offline packages", () => {
  it("import = choose, inspect, confirm; the list follows", async () => {
    const r = rig({ offlineList: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([entry("wheel")]) });
    await r.service.chooseImport();
    expect(r.service.getState().inspection).toEqual(WHEEL);
    expect(r.ipc.offlineImport).not.toHaveBeenCalled();
    await r.service.confirmImport();
    expect(r.ipc.offlineImport).toHaveBeenCalledWith(WHEEL.path);
    expect(r.service.getState().offline).toHaveLength(1);
    expect(r.service.getState().notice).toMatch(/pip in new terminals/);
  });

  it("an incompatible or unknown file is never imported", async () => {
    const r = rig({
      offlineInspect: vi.fn().mockResolvedValue({ ...WHEEL, compatible: false, reason: "for manylinux" }),
    });
    await r.service.chooseImport();
    expect(await r.service.confirmImport()).toBeNull();
    expect(r.ipc.offlineImport).not.toHaveBeenCalled();
  });

  it("a cancelled file dialog does nothing", async () => {
    const r = rig({}, { pickFile: vi.fn().mockResolvedValue(null) });
    await r.service.chooseImport();
    expect(r.ipc.offlineInspect).not.toHaveBeenCalled();
  });

  it("an imported .vsix goes to the extension installer (its trust dialog)", async () => {
    const r = rig({
      offlineInspect: vi.fn().mockResolvedValue({ ...WHEEL, kind: "vsix" }),
      offlineImport: vi.fn().mockResolvedValue(entry("vsix", "v1")),
    });
    await r.service.chooseImport();
    await r.service.confirmImport();
    expect(r.ipc.offlinePath).toHaveBeenCalledWith("v1");
    expect(r.host.installVsix).toHaveBeenCalledWith("C:/app/cache/offline/vsix/a.vsix");
  });

  it("extract, remove, clear and open folder", async () => {
    const r = rig();
    expect(await r.service.extract("s1")).toBe(true);
    expect(r.ipc.offlineExtract).toHaveBeenCalledWith("s1", "C:/work/empty");
    await r.service.remove("s1");
    expect(r.ipc.offlineRemove).toHaveBeenCalledWith("s1");
    await r.service.clearCache();
    expect(r.service.getState().offline).toEqual([]);
    await r.service.openCacheFolder();
    expect(r.host.openFolder).toHaveBeenCalledWith("C:/app/cache/offline");
  });
});
