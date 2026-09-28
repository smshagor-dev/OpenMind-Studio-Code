import { i18n, t } from "../../i18n";
import type { CommandRegistry } from "../commandRegistry";
import type { EditorService } from "../editorService";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { IpcClient } from "../ipc";
import type { OutputService } from "../outputService";
import type { RuntimeService } from "../runtimeService";
import type { SettingsService } from "../settingsService";
import type { TerminalService } from "../terminalService";
import { tauriNetworkIpc, type NetworkIpc } from "./networkIpc";
import { CommandLineTracker } from "./commandLine";
import { NetworkService } from "./networkService";

export const NETWORK_SETTINGS = [
  "network.proxy.mode",
  "network.proxy.http",
  "network.proxy.https",
  "network.proxy.socks",
  "network.proxy.noProxy",
  "network.goProxy",
  "network.testUrl",
  "network.offline.useWheelhouse",
];

/** Output channels of tools that talk to the network: every network problem there is worth the card. */
const TOOL_CHANNELS = new Set([
  "Git",
  "Runtime Manager",
  "Composer",
  "LSP",
  "Extensions",
  "Tasks",
  "Run Code",
  "Python",
  "Node.js",
  "PHP",
]);

/** The commands of the Network feature, in the palette and the Terminal menu. */
export const NETWORK_COMMANDS: [string, string][] = [
  ["network.openSettings", "network.palette.openSettings"],
  ["network.testConnection", "network.palette.testConnection"],
  ["network.showTerminalEnv", "network.palette.showTerminalEnv"],
  ["network.clearCredentials", "network.palette.clearCredentials"],
  ["network.importOffline", "network.palette.importOffline"],
  ["network.openCacheFolder", "network.palette.openCacheFolder"],
];

export interface NetworkWiringDeps {
  ipc: IpcClient;
  networkIpc?: NetworkIpc;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  settings: SettingsService;
  output: OutputService;
  terminal: TerminalService;
  runtime: Pick<RuntimeService, "setFailureListener">;
  editor: Pick<EditorService, "setAppActions">;
  installVsix: (path: string) => Promise<void>;
  run: (id: string) => void;
}

/** Removes terminal colour/cursor sequences so the text can be read. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, "");
}

export function wireNetwork(deps: NetworkWiringDeps): NetworkService {
  const { commands, settings } = deps;
  const network = new NetworkService({
    ipc: deps.networkIpc ?? tauriNetworkIpc,
    events: deps.events,
    settingValue: (id) => settings.string(id, ""),
    setSetting: async (id, value) => {
      const result = await settings.set("user", id, value);
      return result.ok ? null : result.error;
    },
    pickFile: () => deps.ipc.openDocumentDialog(),
    pickFolder: () => deps.ipc.openFolderDialog(),
    openFolder: (path) => deps.ipc.panelOpenFolder(path),
    installVsix: deps.installVsix,
    openRuntimeManager: () => {
      deps.run("runtime.manage");
    },
  });

  commands.register("network.openSettings", () => network.openWindow("proxy"));
  commands.register("network.testConnection", async () => {
    await network.openWindow("proxy");
    await network.test();
  });
  commands.register("network.showTerminalEnv", () => network.showTerminalEnv());
  commands.register("network.clearCredentials", async () => {
    if (await network.clearCredentials()) {
      deps.events.emit("appNotice", { message: t("network.credentials.cleared") });
    }
  });
  commands.register("network.importOffline", () => network.chooseImport());
  commands.register("network.openCacheFolder", () => network.openCacheFolder());

  // The commands in the F1 palette, in the UI language.
  const paletteActions = () =>
    NETWORK_COMMANDS.map(([command, key]) => ({ command, label: t(key), inContextMenu: false }));
  deps.editor.setAppActions(paletteActions());
  i18n.subscribe(() => {
    deps.editor.setAppActions(paletteActions());
  });
  // A failed runtime install can be retried from the card.
  deps.runtime.setFailureListener((message, retry) => {
    network.report(message, t("network.failure.sourceRuntime"), retry);
  });

  // A change of a Network setting (Settings page, settings.json, a profile) re-reads the proxy in force.
  settings.onChange(NETWORK_SETTINGS, () => {
    void network.load();
  });

  deps.output.onAppend((channel, line) => {
    network.report(line, channel, null, !TOOL_CHANNELS.has(channel));
  });
  deps.events.on("appError", ({ message }) => {
    network.report(message, t("network.failure.sourceApp"));
  });

  // Each new terminal: the once-per-session notice, its typed commands are followed (for Retry Command), and its
  // output is watched for unmistakable network problems.
  const watched = new Map<string, number>();
  const trackers = new Map<string, CommandLineTracker>();
  let generation = 0;
  let fingerprint: string | null = null;
  /** Retry Command: the failed command again, in a new terminal that has the current proxy variables. */
  const rerun = (command: string) => async () => {
    const id = await deps.terminal.createTerminal();
    if (id !== null) deps.terminal.write(id, `${command}\r`);
  };
  deps.terminal.onInput((id, data) => {
    const tracker = trackers.get(id) ?? new CommandLineTracker();
    trackers.set(id, tracker);
    tracker.feed(data);
  });
  const updateStale = () => {
    const live = deps.terminal.getState().sessions.filter((s) => !s.exited);
    network.setStaleTerminals(live.filter((s) => (watched.get(s.id) ?? generation) < generation).map((s) => s.id));
  };
  deps.terminal.subscribe(() => {
    for (const session of deps.terminal.getState().sessions) {
      if (watched.has(session.id)) continue;
      watched.set(session.id, generation);
      network.terminalStarted();
      const decoder = new TextDecoder();
      deps.terminal.onOutput(session.id, (data) => {
        const text = plain(decoder.decode(data, { stream: true }));
        if (text.length === 0) return;
        const command = trackers.get(session.id)?.last() ?? null;
        network.report(
          text,
          t("network.failure.sourceTerminal"),
          command === null ? null : () => void rerun(command)(),
          true,
          command !== null,
        );
      });
    }
    updateStale();
  });
  // A proxy change makes the terminals opened before it out of date (they keep their environment): say so once.
  network.subscribe(() => {
    const next = network.proxyFingerprint();
    if (next === null || next === fingerprint) return;
    const changed = fingerprint !== null;
    fingerprint = next;
    if (!changed) return;
    generation += 1;
    updateStale();
    if (network.getState().staleTerminals.length > 0) {
      deps.events.emit("appNotice", { message: t("network.terminal.stale") });
    }
  });
  return network;
}
