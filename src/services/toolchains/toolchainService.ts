import type { IpcClient } from "../ipc";
import type { ToolEntry, ToolchainPacks, VerifyResult } from "./toolchainIpc";

/**
 * The bundled toolchain packs (`<app>/tools`): the list, the active version of each tool, Verify and the details
 * dialog. It only reads what is on disk; a version is chosen from those that are really there, and nothing is ever
 * downloaded or installed from here.
 */
export interface ToolchainState {
  packs: ToolchainPacks | null;
  loaded: boolean;
  error: string | null;
  /** The last Verify answer per `<tool>` (the newest wins). */
  verified: Record<string, { at: number; version: string | null; result: VerifyResult }>;
  verifying: string | null;
  /** The tool whose details dialog is open. */
  detailsId: string | null;
}

export class ToolchainService {
  private state: ToolchainState = {
    packs: null,
    loaded: false,
    error: null,
    verified: {},
    verifying: null,
    detailsId: null,
  };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ipc: Pick<
      IpcClient,
      "toolchainsList" | "toolchainsSetActive" | "toolchainsVerify"
    >,
    /** Called after the active version of a tool changed (the language status is looked up again). */
    private readonly onChanged: () => void = () => undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): ToolchainState {
    return this.state;
  }

  tool(id: string): ToolEntry | undefined {
    return this.state.packs?.tools.find((tool) => tool.id === id);
  }

  async refresh(): Promise<void> {
    try {
      const packs = await this.ipc.toolchainsList();
      this.set({ packs, loaded: true, error: null });
    } catch (err) {
      this.set({ loaded: true, error: message(err) });
    }
  }

  /** Why a version can't be chosen right now (null = it can). */
  selectBlocker(id: string, version: string): string | null {
    const tool = this.tool(id);
    const entry = tool?.versions.find((v) => v.version === version);
    if (!tool || !entry) return "That version isn't listed.";
    if (entry.status === "broken") return "Its program is missing from the tools folder.";
    if (entry.status === "active") return "It is already the active version.";
    return null;
  }

  async setActive(id: string, version: string): Promise<void> {
    if (this.selectBlocker(id, version) !== null) return;
    try {
      const packs = await this.ipc.toolchainsSetActive(id, version);
      this.set({ packs, error: null });
      this.onChanged();
    } catch (err) {
      this.set({ error: message(err) });
    }
  }

  async verify(id: string, version: string | null = null): Promise<void> {
    this.set({ verifying: id });
    try {
      const result = await this.ipc.toolchainsVerify(id, version);
      this.set({
        verifying: null,
        verified: { ...this.state.verified, [id]: { at: this.now(), version, result } },
      });
    } catch (err) {
      this.set({
        verifying: null,
        verified: {
          ...this.state.verified,
          [id]: {
            at: this.now(),
            version,
            result: { ok: false, message: message(err), executed: false, output: null },
          },
        },
      });
    }
  }

  openDetails(id: string): void {
    this.set({ detailsId: id });
  }

  closeDetails(): void {
    this.set({ detailsId: null });
  }

  private set(patch: Partial<ToolchainState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
