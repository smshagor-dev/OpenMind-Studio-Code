import type { LspServerInfo } from "../ipc";
import type { LspService } from "../lspService";
import { toolState } from "./languageToolsModel";

export interface LanguageToolsPromptState {
  /** The server the card offers to install, or `null` when no card is shown. */
  serverId: string | null;
  /** Its install (started from the card) is running. */
  installing: boolean;
}

export interface LanguageToolsPromptDeps {
  lsp: Pick<LspService, "subscribe" | "activeFileStatus" | "isInstalling" | "install" | "servers">;
  /** Calls `listener` when another editor tab comes to the front; returns the unsubscribe. */
  onActiveChange: (listener: () => void) => () => void;
}

/**
 * The bottom-right "Fortran language support is incomplete because fortls is not installed. [Install now] [Dismiss]"
 * card. It appears when the file in front has a registered language server that is missing and can be downloaded with
 * one click — never for a language without a server (Pascal), one that is installed, installing, carried by the offline
 * bundle, can't be installed now, or while language servers are turned off (the file then has no sync outcome).
 * Each server is offered at most once per session: after Install, Dismiss or another language's card replaced it, it
 * doesn't come back until the app starts again (nothing is saved).
 */
export class LanguageToolsPromptService {
  private state: LanguageToolsPromptState = { serverId: null, installing: false };
  private readonly listeners = new Set<() => void>();
  private readonly offered = new Set<string>();
  private readonly offs: (() => void)[] = [];

  constructor(private readonly deps: LanguageToolsPromptDeps) {}

  start(): void {
    this.offs.push(
      this.deps.lsp.subscribe(() => {
        this.evaluate();
      }),
      this.deps.onActiveChange(() => {
        this.evaluate();
      }),
    );
    this.evaluate();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  getState = (): LanguageToolsPromptState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The server the card is about (null without a card). */
  server(): LspServerInfo | null {
    const id = this.state.serverId;
    return id === null ? null : (this.deps.lsp.servers().find((server) => server.id === id) ?? null);
  }

  /** Install now: one click, no other dialog; the server starts for the open files when it is ready. */
  async install(): Promise<boolean> {
    const id = this.state.serverId;
    if (id === null || this.state.installing) return false;
    this.set({ serverId: id, installing: true });
    const ok = await this.deps.lsp.install(id);
    // Success shows the "installed" notice and failure the error (both from the language server service).
    this.set({ serverId: null, installing: false });
    return ok;
  }

  dismiss(): void {
    if (this.state.installing) return;
    this.set({ serverId: null, installing: false });
  }

  private evaluate(): void {
    if (this.state.installing) return;
    const current = this.server();
    if (current !== null && !this.offerable(current)) {
      this.set({ serverId: null, installing: false });
    }
    const status = this.deps.lsp.activeFileStatus();
    const candidate = status.server;
    if (status.outcome?.state !== "notInstalled" || candidate === null) return;
    if (this.offered.has(candidate.id) || !this.offerable(candidate)) return;
    this.offered.add(candidate.id);
    this.set({ serverId: candidate.id, installing: false });
  }

  private offerable(server: LspServerInfo): boolean {
    return toolState(server, this.deps.lsp.isInstalling(server.id)) === "missing";
  }

  private set(state: LanguageToolsPromptState): void {
    if (state.serverId === this.state.serverId && state.installing === this.state.installing) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
