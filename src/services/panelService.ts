import type { IpcClient } from "./ipc";

export type PanelTab = "problems" | "output" | "debugConsole" | "terminal" | "ports";

export const PANEL_TABS: readonly PanelTab[] = [
  "problems",
  "output",
  "debugConsole",
  "terminal",
  "ports",
];

export const PANEL_TAB_LABELS: Record<PanelTab, string> = {
  problems: "Problems",
  output: "Output",
  debugConsole: "Debug Console",
  terminal: "Terminal",
  ports: "Ports",
};

export interface PanelState {
  visible: boolean;
  height: number;
  activeTab: PanelTab;
}

export const DEFAULT_PANEL_HEIGHT = 260;
export const PANEL_MIN_HEIGHT = 120;
export const PANEL_MAX_HEIGHT = 900;

const STATE_KEY = "panel.state";
/** Milestone 4 stored the terminal panel's visibility/height here; honored once, on first load. */
const LEGACY_TERMINAL_KEY = "terminal.state";

const DEFAULT_STATE: PanelState = {
  visible: false,
  height: DEFAULT_PANEL_HEIGHT,
  activeTab: "terminal",
};

/**
 * The bottom panel's shell: whether it is shown, how tall, and which tab
 * (Problems / Output / Debug Console / Terminal / Ports) is selected. What each
 * tab *contains* belongs to that tab's own service; this only owns the frame,
 * persisted as one JSON value in `editor_settings`.
 */
export class PanelService {
  private state: PanelState = DEFAULT_STATE;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ipc: IpcClient) {}

  getState(): PanelState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    const saved = await this.ipc.settingsGet(STATE_KEY).catch(() => null);
    if (saved !== null) {
      this.state = parseState(saved);
    } else {
      const legacy = await this.ipc.settingsGet(LEGACY_TERMINAL_KEY).catch(() => null);
      if (legacy !== null) {
        this.state = parseLegacy(legacy);
      }
    }
    // The panel (terminal area) opens only when the user opens it: its height and
    // tab are restored, but it always starts hidden.
    this.state = { ...this.state, visible: false };
    this.notify();
  }

  /** Shows the panel on `tab` (or on whichever tab was last selected). */
  async show(tab?: PanelTab): Promise<void> {
    await this.update({ visible: true, activeTab: tab ?? this.state.activeTab });
  }

  async hide(): Promise<void> {
    if (this.state.visible) {
      await this.update({ visible: false });
    }
  }

  async toggle(): Promise<void> {
    await (this.state.visible ? this.hide() : this.show());
  }

  /** Selects a tab; the panel is shown if it was hidden (you can only click a tab you can see, but commands can too). */
  async setActiveTab(tab: PanelTab): Promise<void> {
    if (this.state.activeTab !== tab || !this.state.visible) {
      await this.update({ visible: true, activeTab: tab });
    }
  }

  /** Live resize while dragging the sash — no persisting every pixel. */
  previewHeight(height: number): void {
    this.state = { ...this.state, height: clampHeight(height) };
    this.notify();
  }

  async commitHeight(): Promise<void> {
    await this.persist();
  }

  private async update(patch: Partial<PanelState>): Promise<void> {
    this.state = { ...this.state, ...patch };
    this.notify();
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.ipc.settingsSet(STATE_KEY, JSON.stringify(this.state)).catch(() => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function clampHeight(height: number): number {
  return Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, Math.round(height)));
}

function isTab(value: unknown): value is PanelTab {
  return PANEL_TABS.includes(value as PanelTab);
}

function parseState(raw: string): PanelState {
  try {
    const value = JSON.parse(raw) as Partial<PanelState>;
    return {
      visible: value.visible === true,
      height: typeof value.height === "number" ? clampHeight(value.height) : DEFAULT_PANEL_HEIGHT,
      activeTab: isTab(value.activeTab) ? value.activeTab : "terminal",
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function parseLegacy(raw: string): PanelState {
  try {
    const value = JSON.parse(raw) as { panelVisible?: unknown; panelHeight?: unknown };
    return {
      visible: value.panelVisible === true,
      height:
        typeof value.panelHeight === "number"
          ? clampHeight(value.panelHeight)
          : DEFAULT_PANEL_HEIGHT,
      activeTab: "terminal",
    };
  } catch {
    return DEFAULT_STATE;
  }
}
