import type { IpcClient } from "./ipc";

export interface LayoutState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  sidebarPosition: "left" | "right";
  statusBarVisible: boolean;
  breadcrumbsVisible: boolean;
  /** Explorer's "Open Editors" section: shown at all (views menu) / expanded (header click). */
  openEditorsVisible: boolean;
  openEditorsExpanded: boolean;
  /** Explorer's workspace-folder section expanded (header click). */
  folderExpanded: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
  sidebarVisible: true,
  sidebarWidth: 260,
  sidebarPosition: "left",
  statusBarVisible: true,
  breadcrumbsVisible: true,
  openEditorsVisible: true,
  openEditorsExpanded: false,
  folderExpanded: true,
};

export const SIDEBAR_MIN_WIDTH = 170;
export const SIDEBAR_MAX_WIDTH = 800;

const LAYOUT_KEY = "workbench.layout";
/** Milestone 3 stored only sidebar visibility, under its own key — still honored on first load. */
const LEGACY_SIDEBAR_KEY = "sidebar.visible";

type BooleanLayoutKey = {
  [K in keyof LayoutState]: LayoutState[K] extends boolean ? K : never;
}[keyof LayoutState];

/**
 * Workbench layout (sidebar/status bar/breadcrumbs visibility, sidebar width
 * and side, explorer section state), kept outside React and persisted as one
 * JSON value in `editor_settings` after every change.
 */
export class LayoutService {
  private state: LayoutState = DEFAULT_LAYOUT;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ipc: IpcClient) {}

  getState(): LayoutState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    const saved = await this.ipc.settingsGet(LAYOUT_KEY).catch(() => null);
    if (saved !== null) {
      this.state = parseLayout(saved);
    } else {
      const legacy = await this.ipc.settingsGet(LEGACY_SIDEBAR_KEY).catch(() => null);
      if (legacy !== null) {
        this.state = { ...DEFAULT_LAYOUT, sidebarVisible: legacy === "true" };
      }
    }
    this.notify();
  }

  async toggle(key: BooleanLayoutKey): Promise<void> {
    await this.update({ [key]: !this.state[key] });
  }

  async setSidebarVisible(visible: boolean): Promise<void> {
    await this.update({ sidebarVisible: visible });
  }

  async toggleSidebarPosition(): Promise<void> {
    await this.update({
      sidebarPosition: this.state.sidebarPosition === "left" ? "right" : "left",
    });
  }

  /** Live resize while dragging the sash — updates the UI without persisting every pixel. */
  previewSidebarWidth(width: number): void {
    this.state = { ...this.state, sidebarWidth: clampWidth(width) };
    this.notify();
  }

  /** Persists the current width (call once, when the sash drag ends). */
  async commitSidebarWidth(): Promise<void> {
    await this.persist();
  }

  private async update(patch: Partial<LayoutState>): Promise<void> {
    this.state = { ...this.state, ...patch };
    this.notify();
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.ipc.settingsSet(LAYOUT_KEY, JSON.stringify(this.state)).catch(() => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function clampWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

function parseLayout(raw: string): LayoutState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return DEFAULT_LAYOUT;
  }
  const record = parsed as Record<string, unknown>;
  const state: LayoutState = { ...DEFAULT_LAYOUT };
  for (const key of Object.keys(DEFAULT_LAYOUT) as (keyof LayoutState)[]) {
    const value = record[key];
    if (typeof value === typeof DEFAULT_LAYOUT[key]) {
      Object.assign(state, { [key]: value });
    }
  }
  if (record.sidebarPosition !== "left" && record.sidebarPosition !== "right") {
    state.sidebarPosition = "left";
  }
  state.sidebarWidth = clampWidth(state.sidebarWidth);
  return state;
}
