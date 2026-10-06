import { afterEach, describe, expect, it, vi } from "vitest";

import { i18n } from "../../i18n";
import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import { CommandRegistry } from "../commandRegistry";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { OutputService } from "../outputService";
import type { SettingsService } from "../settingsService";
import type { TerminalService } from "../terminalService";
import type { ShellKind } from "../ipc";
import type { NetworkIpc } from "./networkIpc";
import { NETWORK_COMMANDS, wireNetwork } from "./networkWiring";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  i18n.setLanguage("en");
});

function rig(options: { confirm?: string | null; shells?: ShellKind[] } = {}) {
  const events = new EventBus<AppEvents>();
  const notices: string[] = [];
  events.on("appNotice", ({ message }) => notices.push(message));
  const commands = new CommandRegistry();
  const output = new OutputService();
  const onChange = vi.fn();
  const settings = {
    string: () => "",
    set: vi.fn().mockResolvedValue({ ok: true }),
    onChange,
  } as unknown as SettingsService;
  let sessions: { id: string; shell: ShellKind; cwd: string; exited: boolean }[] = [];
  const terminalListeners = new Set<() => void>();
  const taps = new Map<string, (data: Uint8Array) => void>();
  const inputs = new Set<(id: string, data: string) => void>();
  const createTerminal = vi.fn((shell?: ShellKind, cwd?: string | null) => {
    const id = `t${String(sessions.length + 1)}`;
    sessions = [...sessions, { id, shell: shell ?? "powerShell", cwd: cwd ?? "E:/work", exited: false }];
    for (const listener of terminalListeners) listener();
    return Promise.resolve<string | null>(id);
  });
  const closeTerminal = vi.fn((id: string) => {
    sessions = sessions.filter((s) => s.id !== id);
    for (const listener of terminalListeners) listener();
    return Promise.resolve();
  });
  const write = vi.fn();
  const shells = (options.shells ?? ["powerShell", "cmd"]).map((kind) => ({ kind, label: kind, available: true }));
  const terminal = {
    getState: () => ({ sessions, shells, lastShell: shells[0]?.kind ?? null, activeId: sessions[0]?.id ?? null }),
    subscribe: (listener: () => void) => {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
    onOutput: (id: string, listener: (data: Uint8Array) => void) => {
      taps.set(id, listener);
      return () => taps.delete(id);
    },
    onInput: (listener: (id: string, data: string) => void) => {
      inputs.add(listener);
      return () => inputs.delete(listener);
    },
    createTerminal,
    closeTerminal,
    write,
  } as unknown as TerminalService;
  const confirm = vi.fn().mockResolvedValue(options.confirm === undefined ? "OK" : options.confirm);
  const terminalLine = vi.fn((argv: string[]) => Promise.resolve(argv.map((a) => `'${a}'`).join(" ")));
  let failure: ((message: string, retry: () => void) => void) | null = null;
  const setAppActions = vi.fn();
  const networkIpc = {
    networkStatus: vi.fn().mockResolvedValue({ mode: "manual", active: true }),
    offlineList: vi.fn().mockResolvedValue([]),
  } as unknown as NetworkIpc;
  const network = wireNetwork({
    ipc: createFakeIpc(),
    networkIpc,
    events,
    commands,
    settings,
    output,
    terminal,
    runtime: {
      setFailureListener: (listener) => {
        failure = listener;
      },
    },
    editor: { setAppActions },
    installVsix: vi.fn(),
    run: vi.fn(),
    confirm,
    terminalLine,
  });
  return {
    events,
    commands,
    output,
    network,
    onChange,
    setAppActions,
    networkIpc,
    confirm,
    closeTerminal,
    terminalLine,
    setTerminals: (next: { id: string; shell: ShellKind; cwd: string }[]) => {
      sessions = next.map((s) => ({ ...s, exited: false }));
      for (const listener of terminalListeners) listener();
    },
    addTerminal: (id: string, shell: ShellKind = "powerShell", cwd = "E:/work") => {
      sessions = [...sessions, { id, shell, cwd, exited: false }];
      for (const listener of terminalListeners) listener();
    },
    print: (id: string, text: string) => taps.get(id)?.(new TextEncoder().encode(text)),
    type: (id: string, text: string) => {
      for (const listener of inputs) listener(id, text);
    },
    createTerminal,
    write,
    notices: () => notices,
    failRuntime: (message: string, retry: () => void) => failure?.(message, retry),
  };
}

describe("wireNetwork", () => {
  it("registers every Network command and puts them in the palette in the UI language", () => {
    const r = rig();
    for (const [id] of NETWORK_COMMANDS) expect(r.commands.has(id), id).toBe(true);
    const labels = (r.setAppActions.mock.calls[0]?.[0] as { label: string }[]).map((a) => a.label);
    expect(labels).toContain("Network: Open Proxy Settings");
    i18n.setLanguage("ru");
    const ru = (r.setAppActions.mock.lastCall?.[0] as { label: string }[]).map((a) => a.label);
    expect(ru).toContain("Сеть: открыть параметры прокси");
  });

  it("follows every Network setting", () => {
    const r = rig();
    expect(r.onChange.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(["network.proxy.mode", "network.proxy.noProxy"]));
  });

  it("a tool's Output channel line with a network problem shows the card", () => {
    const r = rig();
    r.output.append("Git", "fatal: unable to access 'https://x/': Could not resolve host: github.com");
    expect(r.network.getState().failure).toMatchObject({ problem: "dns", source: "Git" });
  });

  it("terminal output shows the card only for unmistakable problems", async () => {
    const r = rig();
    await r.network.load();
    r.addTerminal("t1");
    r.print("t1", "Request timed out.\r\n");
    expect(r.network.getState().failure).toBeNull();
    r.print("t1", "\u001b[31mERROR: ProxyError('Cannot connect to proxy.')\u001b[0m");
    expect(r.network.getState().failure?.problem).toBe("proxyUnavailable");
  });

  it("a failed runtime install can be retried from the card", () => {
    const r = rig();
    const retry = vi.fn();
    r.failRuntime("download failed (proxy authentication required): HTTP 407", retry);
    expect(r.network.getState().failure?.retry).not.toBeNull();
    r.network.retryFailure();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("the university pip failure is proxy authentication, and Retry Command reruns it in a new proxy-ready terminal", async () => {
    const r = rig();
    await r.network.load();
    r.addTerminal("t1");
    r.type("t1", "pip install requests\r");
    r.print(
      "t1",
      "WARNING: Retrying ... ProxyError('Unable to connect to proxy', OSError('Tunnel connection failed: 407 Proxy Authentication Required'))\r\n" +
        "ERROR: Could not find a version that satisfies the requirement requests (from versions: none)\r\n" +
        "ERROR: No matching distribution found for requests\r\n",
    );
    const failure = r.network.getState().failure;
    expect(failure).toMatchObject({ problem: "proxyAuthRequired", retryIsCommand: true });
    r.network.retryFailure();
    await flush();
    expect(r.createTerminal).toHaveBeenCalledOnce();
    expect(r.write).toHaveBeenCalledWith("t2", "pip install requests\r");
    // A safe command runs without a question.
    expect(r.confirm).not.toHaveBeenCalled();
  });

  it("a 407 wrapped by a narrow terminal, and split across two output chunks, is still proxy authentication", async () => {
    const r = rig();
    await r.network.load();
    r.addTerminal("t1", "powerShell", "E:/My Projects/site");
    r.type("t1", "python -m pip download six\r");
    // What ConPTY sent in the smoke: the line broken at the terminal's width, the break at a chunk boundary.
    r.print("t1", "WARNING: Retrying after connection broken by 'ProxyError('Cannot connect to proxy.', OSError('Tunnel connection failed: 407 Proxy Authenticatio");
    r.print("t1", "\r\nn Required'))': /simple/six/\r\nERROR: No matching distribution found for six\r\n");
    expect(r.network.getState().failure).toMatchObject({ problem: "proxyAuthRequired", pip: true });
  });

  it("Retry Command keeps the shell and folder of the terminal it failed in", async () => {
    const r = rig();
    await r.network.load();
    r.addTerminal("t1", "cmd", "E:/My Projects/site");
    r.type("t1", "pip install django pandas\r");
    r.print("t1", "OSError('Tunnel connection failed: 407 Proxy Authentication Required')\r\nERROR: No matching distribution found for django\r\n");
    expect(r.network.getState().failure).toMatchObject({ problem: "proxyAuthRequired", pip: true });
    r.network.retryFailure();
    await flush();
    expect(r.createTerminal).toHaveBeenCalledWith("cmd", "E:/My Projects/site");
    expect(r.write).toHaveBeenCalledWith("t2", "pip install django pandas\r");
  });

  it("a risky command is retried only after the user confirms", async () => {
    const r = rig({ confirm: null });
    await r.network.load();
    r.addTerminal("t1");
    r.type("t1", "Remove-Item -Recurse build; npm install\r");
    r.print("t1", "npm ERR! code E407\r\nnpm ERR! 407 Proxy Authentication Required\r\n");
    r.network.retryFailure();
    await flush();
    expect(r.confirm).toHaveBeenCalledOnce();
    expect(r.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: "Run this command again?",
      details: [
        { label: "Command", value: "Remove-Item -Recurse build; npm install" },
        { label: "Folder", value: "E:/work" },
      ],
    });
    expect(r.createTerminal).not.toHaveBeenCalled();
    expect(r.write).not.toHaveBeenCalled();
    // Confirmed, it runs.
    r.confirm.mockResolvedValueOnce("Run Command");
    r.print("t1", "npm ERR! 407 Proxy Authentication Required\r\n");
    r.network.retryFailure();
    await flush();
    expect(r.write).toHaveBeenCalledWith("t2", "Remove-Item -Recurse build; npm install\r");
  });

  it("Restart This Terminal With Proxy asks first, opens the new terminal before closing the old one, and Cancel keeps it", async () => {
    const r = rig({ confirm: null });
    r.addTerminal("t1", "gitBash", "E:/lab work");
    await r.network.restartTerminal("t1");
    expect(r.confirm.mock.calls[0]?.[0]).toMatchObject({
      title: "Restart this terminal?",
      details: [
        { label: "Shell", value: "gitBash" },
        { label: "Folder", value: "E:/lab work" },
      ],
    });
    expect(r.createTerminal).not.toHaveBeenCalled();
    expect(r.closeTerminal).not.toHaveBeenCalled();
    r.confirm.mockResolvedValueOnce("Restart Terminal");
    await r.network.restartTerminal("t1");
    expect(r.createTerminal).toHaveBeenCalledWith("gitBash", "E:/lab work");
    expect(r.closeTerminal).toHaveBeenCalledWith("t1");
    // If the new terminal can't start, the old one stays and the user is told.
    const errors: string[] = [];
    r.events.on("appError", ({ message }) => errors.push(message));
    r.addTerminal("t9");
    r.createTerminal.mockResolvedValueOnce(null);
    r.confirm.mockResolvedValueOnce("Restart Terminal");
    await r.network.restartTerminal("t9");
    expect(r.closeTerminal).not.toHaveBeenCalledWith("t9");
    expect(errors).toEqual(["A new terminal couldn't be started; the current one was kept."]);
  });

  it("Keep Current Terminal silences it until the next change of the package settings", async () => {
    const r = rig();
    await r.network.load();
    r.addTerminal("t1");
    const status = r.networkIpc.networkStatus as ReturnType<typeof vi.fn>;
    status.mockResolvedValue({ mode: "manual", active: true, useWheelhouse: true });
    await r.network.load();
    expect(r.network.getState().staleTerminals).toEqual(["t1"]);
    r.network.keepTerminal("t1");
    expect(r.network.getState().staleTerminals).toEqual([]);
    r.addTerminal("t2");
    expect(r.network.getState().staleTerminals).toEqual([]);
    status.mockResolvedValue({ mode: "manual", active: true, useWheelhouse: false });
    await r.network.load();
    expect(r.network.getState().staleTerminals).toEqual(["t1", "t2"]);
  });

  it("Open New Proxy-Ready Terminal can copy the shell and folder of a stale terminal", async () => {
    const r = rig();
    r.addTerminal("t1", "cmd", "E:/old folder");
    await r.network.openProxyReadyTerminal("t1");
    expect(r.createTerminal).toHaveBeenLastCalledWith("cmd", "E:/old folder");
    await r.network.openProxyReadyTerminal();
    expect(r.createTerminal).toHaveBeenLastCalledWith();
  });

  it("the offline pip command is quoted for the shell and typed into a new terminal; WSL alone can't take it", async () => {
    const r = rig();
    (r.networkIpc as unknown as Record<string, unknown>).wheelhouseCommand = vi
      .fn()
      .mockResolvedValue(["python", "-m", "pip", "install", "--no-index", "--find-links=file:///E:/My%20USB/wheels", "django", "pandas"]);
    expect(await r.network.installFromWheelhouse("django pandas")).toBe(true);
    expect(r.terminalLine).toHaveBeenCalledWith(
      ["python", "-m", "pip", "install", "--no-index", "--find-links=file:///E:/My%20USB/wheels", "django", "pandas"],
      "powerShell",
    );
    expect(r.write).toHaveBeenCalledWith(
      "t1",
      "'python' '-m' 'pip' 'install' '--no-index' '--find-links=file:///E:/My%20USB/wheels' 'django' 'pandas'\r",
    );
    const wsl = rig({ shells: ["wsl"] });
    (wsl.networkIpc as unknown as Record<string, unknown>).wheelhouseCommand = vi.fn().mockResolvedValue(["python"]);
    expect(await wsl.network.installFromWheelhouse("django")).toBe(false);
    expect(wsl.network.getState().error).toContain("WSL");
    expect(wsl.createTerminal).not.toHaveBeenCalled();
  });

  it("a proxy change doesn't make terminals stale: the gateway uses the proxy in force at each request", async () => {
    const r = rig();
    await r.network.load();
    r.addTerminal("t1");
    (r.networkIpc.networkStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: "manual", active: true, http: "http://proxy.lab:3128" });
    await r.network.load();
    expect(r.network.getState().staleTerminals).toEqual([]);
    expect(r.notices()).toEqual([]);
  });

  it("a change of what new terminals get (the offline wheels) marks the terminals opened before it, once", async () => {
    const r = rig();
    await r.network.load();
    r.addTerminal("t1");
    expect(r.network.getState().staleTerminals).toEqual([]);
    (r.networkIpc.networkStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: "manual", active: true, useWheelhouse: true });
    await r.network.load();
    expect(r.network.getState().staleTerminals).toEqual(["t1"]);
    expect(r.notices()).toContain(
      "Package settings changed. Terminals opened before the change still use the old ones: open a new terminal.",
    );
    r.addTerminal("t2");
    expect(r.network.getState().staleTerminals).toEqual(["t1"]);
  });

  it("no toast about stale terminals while the failure card is up (it would cover the card's buttons)", async () => {
    const r = rig();
    await r.network.load();
    r.addTerminal("t1");
    r.output.append("Git", "fatal: unable to access 'https://x/': Received HTTP code 407 from proxy after CONNECT");
    expect(r.network.getState().failure).not.toBeNull();
    (r.networkIpc.networkStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ mode: "manual", active: true, useWheelhouse: true });
    await r.network.load();
    expect(r.network.getState().staleTerminals).toEqual(["t1"]);
    expect(r.notices()).not.toContain(
      "Package settings changed. Terminals opened before the change still use the old ones: open a new terminal.",
    );
  });

  it("nothing is contacted when wired: no test, no request", () => {
    const r = rig();
    expect(r.networkIpc.networkStatus).not.toHaveBeenCalled();
  });
});
