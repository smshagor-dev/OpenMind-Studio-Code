import type { IpcClient } from "./ipc";

/** Saved in `editor_settings` (a main-window workbench key, like `panel.state`). */
export const SECONDARY_SIDEBAR_KEY = "workbench.secondarySideBar";
export const SECONDARY_MIN_WIDTH = 220;
export const SECONDARY_MAX_WIDTH = 1600;
const DEFAULT_WIDTH = 420;
/** The channel it shows before anything picked one. */
const DEFAULT_CHANNEL = "Run Code";

export interface SecondarySideBarState {
  visible: boolean;
  /** Takes half of the editor + secondary side bar row (how Run Code opens it), until dragged. */
  half: boolean;
  /** Width in pixels once the sash was dragged. */
  width: number;
  /** The Output channel it shows. */
  channel: string;
  /** What it shows: an Output channel, or the built-in browser (Run Code on an HTML file). */
  view: SecondaryView;
}

export type SecondaryView = "output" | "browser";

const INITIAL: SecondarySideBarState = {
  visible: false,
  half: true,
  width: DEFAULT_WIDTH,
  channel: DEFAULT_CHANNEL,
  view: "output",
};

export function clampSecondaryWidth(width: number): number {
  return Math.round(Math.min(SECONDARY_MAX_WIDTH, Math.max(SECONDARY_MIN_WIDTH, width)));
}

/**
 * VS Code's Secondary Side Bar: a card on the far side of the editor (right,
 * or left when the primary side bar is on the right). It shows an Output
 * channel next to the code — Run Code opens it at half the width with the
 * run's channel, while the bottom panel's Output shows the same lines.
 * Toggled from the title bar or with Ctrl+Alt+B; the sash sets a fixed width.
 */
export class SecondarySideBarService {
  private state: SecondarySideBarState = INITIAL;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ipc: IpcClient) {}

  getState(): SecondarySideBarState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    const saved = await this.ipc.settingsGet(SECONDARY_SIDEBAR_KEY).catch(() => null);
    const parsed = parseSaved(saved);
    if (parsed !== null) this.set(parsed);
  }

  async toggle(): Promise<void> {
    await this.update({ visible: !this.state.visible });
  }

  async hide(): Promise<void> {
    await this.update({ visible: false });
  }

  /** Shows `channel` beside the editor at half the width (Run Code's split). */
  async showOutput(channel: string): Promise<void> {
    await this.update({ visible: true, half: true, channel, view: "output" });
  }

  /** Shows the built-in browser beside the editor at half the width (Run Code on an HTML file). */
  async showBrowser(): Promise<void> {
    await this.update({ visible: true, half: true, view: "browser" });
  }

  async setView(view: SecondaryView): Promise<void> {
    await this.update({ view });
  }

  async setChannel(channel: string): Promise<void> {
    await this.update({ channel });
  }

  /** Live resize while the sash is dragged (a fixed width from now on); not saved per pixel. */
  previewWidth(width: number): void {
    this.set({ half: false, width: clampSecondaryWidth(width) });
  }

  async commitWidth(): Promise<void> {
    await this.persist();
  }

  private async update(patch: Partial<SecondarySideBarState>): Promise<void> {
    this.set(patch);
    await this.persist();
  }

  private set(patch: Partial<SecondarySideBarState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async persist(): Promise<void> {
    await this.ipc
      .settingsSet(SECONDARY_SIDEBAR_KEY, JSON.stringify(this.state))
      .catch(() => undefined);
  }
}

function parseSaved(saved: string | null): Partial<SecondarySideBarState> | null {
  if (saved === null) return null;
  try {
    const value: unknown = JSON.parse(saved);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const patch: Partial<SecondarySideBarState> = {};
    if (typeof record.visible === "boolean") patch.visible = record.visible;
    if (typeof record.half === "boolean") patch.half = record.half;
    if (typeof record.width === "number" && Number.isFinite(record.width)) {
      patch.width = clampSecondaryWidth(record.width);
    }
    if (typeof record.channel === "string" && record.channel !== "") {
      patch.channel = record.channel;
    }
    // The browser's page isn't restored after a restart, so it always comes back on its Output.
    patch.view = "output";
    return patch;
  } catch {
    return null;
  }
}
