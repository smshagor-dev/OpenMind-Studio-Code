import { i18n, t } from "../../i18n";
import type { CommandRegistry } from "../commandRegistry";
import type { EditorService } from "../editorService";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { ConfirmPrompt } from "../extensionPromptService";
import type { IpcClient, ShellKind } from "../ipc";
import { tauriLanguageIpc, type TerminalShellStyle } from "../language/languageIpc";
import type { OutputService } from "../outputService";
import type { RuntimeService } from "../runtimeService";
import type { SettingsService } from "../settingsService";
import { typeInNewTerminal } from "../terminalCommand";
import type { TerminalService } from "../terminalService";
import { tauriNetworkIpc, type NetworkIpc } from "./networkIpc";
import { CommandLineTracker } from "./commandLine";
import { isRiskyCommand } from "./networkModel";
import { NetworkService, type NetworkTerminalHost } from "./networkService";

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
  /** The confirmation dialog (the one tasks use); resolves with the chosen button, `null` when cancelled. */
  confirm: (request: Omit<ConfirmPrompt, "kind" | "id">) => Promise<string | null>;
  /** Quotes an argument list for a shell (the backend's `language_terminal_line`). */
  terminalLine?: (argv: string[], style: TerminalShellStyle) => Promise<string>;
}

/**
 * The terminal side of the Network feature: new proxy-ready terminals, Restart With Proxy, Retry Command and running
 * the offline pip command. A new terminal always gets the current proxy variables (the backend adds them when the
 * shell starts); nothing is ever typed or closed without a click, and a restart or a risky command asks first.
 */
function terminalHost(deps: NetworkWiringDeps): NetworkTerminalHost & {
  retry: (command: string, from: string) => Promise<void>;
} {
  const terminal = deps.terminal;
  const session = (id: string | null) =>
    id === null ? undefined : terminal.getState().sessions.find((candidate) => candidate.id === id);
  const shellLabel = (kind: ShellKind) =>
    terminal.getState().shells.find((shell) => shell.kind === kind)?.label ?? kind;
  /** A new terminal like `from` (same shell, same starting folder), or the default one. */
  const openLike = (from: string | null) => {
    const like = session(from);
    return like === undefined ? terminal.createTerminal() : terminal.createTerminal(like.shell, like.cwd);
  };
  const line = deps.terminalLine ?? ((argv, style) => tauriLanguageIpc.languageTerminalLine(argv, style));
  return {
    openProxyReady: async (from) => {
      await openLike(from);
      return null;
    },
    restart: async (id) => {
      const old = session(id);
      if (old === undefined) return t("network.stale.gone");
      const answer = await deps.confirm({
        extension: t("network.title"),
        title: t("network.stale.confirmTitle"),
        details: [
          { label: t("network.detail.shell"), value: shellLabel(old.shell) },
          { label: t("network.detail.folder"), value: old.cwd },
        ],
        notes: [t("network.stale.confirmNote")],
        buttons: [t("network.stale.confirmButton")],
      });
      if (answer === null) return null;
      // The new terminal first: if it can't start, the old one is kept.
      const replacement = await openLike(id);
      if (replacement === null) return t("network.stale.failed");
      await terminal.closeTerminal(id);
      return null;
    },
    runInNewTerminal: (argv) =>
      typeInNewTerminal(terminal, line, argv, null, {
        noShell: t("network.wheels.noShell"),
        failed: t("network.stale.failed"),
      }),
    /** Retry Command: the command again in a new terminal like the one it failed in; a risky one asks first. */
    retry: async (command, from) => {
      const like = session(from);
      if (isRiskyCommand(command)) {
        const answer = await deps.confirm({
          extension: t("network.title"),
          title: t("network.retry.confirmTitle"),
          details: [
            { label: t("network.detail.command"), value: command },
            { label: t("network.detail.folder"), value: like?.cwd ?? "" },
          ],
          notes: [t("network.retry.confirmNote")],
          buttons: [t("network.retry.confirmButton")],
        });
        if (answer === null) return;
      }
      const id = await openLike(from);
      if (id !== null) terminal.write(id, `${command}\r`);
    },
  };
}

/** Removes terminal colour/cursor sequences so the text can be read. */
export function terminalPlainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, "");
}

export function wireNetwork(deps: NetworkWiringDeps): NetworkService {
  const { commands, settings } = deps;
  const terminals = terminalHost(deps);
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
    terminals,
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
        const text = terminalPlainText(decoder.decode(data, { stream: true }));
        if (text.length === 0) return;
        const command = trackers.get(session.id)?.last() ?? null;
        network.report(
          text,
          t("network.failure.sourceTerminal"),
          command === null ? null : () => void terminals.retry(command, session.id),
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
    network.proxyChanged();
    updateStale();
    // While the failure card is up (the usual way to change the proxy is its Configure Proxy), the terminal banner and
    // the ⚠ label say it; a toast would cover the card's buttons.
    const state = network.getState();
    if (state.staleTerminals.length > 0 && state.failure === null) {
      deps.events.emit("appNotice", { message: t("network.terminal.stale") });
    }
  });
  return network;
}
