import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient, RuntimeStatus } from "./ipc";
import type { RuntimeService } from "./runtimeService";
import { describeRuntimeChange, runtimeFingerprint, TerminalRefreshService } from "./terminalRefreshService";
import type { TerminalService } from "./terminalService";
import { t } from "../i18n";

export interface TerminalRefreshDeps {
  ipc: IpcClient;
  events: EventBus<AppEvents>;
  terminal: TerminalService;
  runtime: RuntimeService;
  /** What can run changed (an interpreter installed, deleted or switched): Run Code asks again. */
  runtimesChanged: (fingerprint: string) => void;
}

/**
 * A shell keeps the PATH it started with: when the active runtimes change (Node.js installed, a version switched or
 * removed), idle terminals are started again in their folder so `node`/`npm`/`npx` work at once; busy ones wait.
 */
export function wireTerminalRefresh(deps: TerminalRefreshDeps): TerminalRefreshService {
  const { events, runtime } = deps;
  const terminalRefresh = new TerminalRefreshService({
    terminal: deps.terminal,
    isBusy: (id) => deps.ipc.terminalBusy(id),
    note: (change, folder) => t("terminal.refresh.note", { change, folder }),
    waiting: (titles) => {
      events.emit("appNotice", { message: t("terminal.refresh.waiting", { titles: titles.join(", ") }) });
    },
  });
  let refreshedRuntimes: RuntimeStatus[] | null = null;
  runtime.subscribe(() => {
    const { loaded, runtimes } = runtime.getState();
    if (!loaded) return;
    if (refreshedRuntimes === null) {
      terminalRefresh.start(runtimeFingerprint(runtimes));
    } else if (runtimeFingerprint(runtimes) !== runtimeFingerprint(refreshedRuntimes)) {
      const change = describeRuntimeChange(refreshedRuntimes, runtimes, (name) =>
        t("terminal.refresh.removed", { name }),
      );
      void terminalRefresh.runtimesChanged(runtimeFingerprint(runtimes), change);
    }
    refreshedRuntimes = runtimes;
  });
  // An interpreter appearing or going (install / delete / switch) changes what can run, and so does an add-on (the
  // Assembly runtime's x86 toolchain makes 32-bit programs buildable).
  runtime.subscribe(() => {
    deps.runtimesChanged(runCodeFingerprint(runtime.getState().runtimes));
  });
  return terminalRefresh;
}

/** What Run Code's answer depends on: per runtime the active version, how many healthy versions, installed add-ons. */
export function runCodeFingerprint(runtimes: readonly RuntimeStatus[]): string {
  return runtimes
    .map((r) => {
      const healthy = r.installed.filter((v) => v.healthy);
      const addons = healthy.flatMap((v) => (v.addons ?? []).filter((a) => a.installed).map((a) => `${v.version}+${a.id}`));
      return `${r.id}:${r.activeVersion ?? "-"}:${String(healthy.length)}:${addons.join("+")}`;
    })
    .join(",");
}
