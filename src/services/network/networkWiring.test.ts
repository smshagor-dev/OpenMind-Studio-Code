import { afterEach, describe, expect, it, vi } from "vitest";

import { i18n } from "../../i18n";
import { createFakeIpc } from "../../testUtils/fakeIpcClient";
import { CommandRegistry } from "../commandRegistry";
import { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import { OutputService } from "../outputService";
import type { SettingsService } from "../settingsService";
import type { TerminalService } from "../terminalService";
import type { NetworkIpc } from "./networkIpc";
import { NETWORK_COMMANDS, wireNetwork } from "./networkWiring";

afterEach(() => {
  i18n.setLanguage("en");
});

function rig() {
  const events = new EventBus<AppEvents>();
  const commands = new CommandRegistry();
  const output = new OutputService();
  const onChange = vi.fn();
  const settings = {
    string: () => "",
    set: vi.fn().mockResolvedValue({ ok: true }),
    onChange,
  } as unknown as SettingsService;
  let sessions: { id: string }[] = [];
  const terminalListeners = new Set<() => void>();
  const taps = new Map<string, (data: Uint8Array) => void>();
  const terminal = {
    getState: () => ({ sessions }),
    subscribe: (listener: () => void) => {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
    onOutput: (id: string, listener: (data: Uint8Array) => void) => {
      taps.set(id, listener);
      return () => taps.delete(id);
    },
  } as unknown as TerminalService;
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
  });
  return {
    events,
    commands,
    output,
    network,
    onChange,
    setAppActions,
    networkIpc,
    addTerminal: (id: string) => {
      sessions = [...sessions, { id }];
      for (const listener of terminalListeners) listener();
    },
    print: (id: string, text: string) => taps.get(id)?.(new TextEncoder().encode(text)),
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

  it("nothing is contacted when wired: no test, no request", () => {
    const r = rig();
    expect(r.networkIpc.networkStatus).not.toHaveBeenCalled();
  });
});
