import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { IpcClient } from "./ipc";

/** The native-window operations the custom title bar needs — injectable so tests need no Tauri runtime. */
export interface WindowApi {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  isFullscreen: () => Promise<boolean>;
  setFullscreen: (fullscreen: boolean) => Promise<void>;
  onCloseRequested?: (handler: (event: { preventDefault(): void }) => Promise<void>) => Promise<() => void>;
  onResized: (handler: () => void) => Promise<() => void>;
  setZoom: (factor: number) => Promise<void>;
}

export const tauriWindowApi: WindowApi = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  // Goes through the normal close path, so the Rust `CloseRequested` handler still saves window state.
  close: () => getCurrentWindow().close(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  isFullscreen: () => getCurrentWindow().isFullscreen(),
  setFullscreen: (fullscreen) => getCurrentWindow().setFullscreen(fullscreen),
  onCloseRequested: handler => getCurrentWindow().onCloseRequested(handler),
  onResized: (handler) => getCurrentWindow().onResized(handler),
  setZoom: (factor) => getCurrentWebview().setZoom(factor),
};

export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
  /** VS Code-style zoom level: 0 = 100%, each step is a 20% scale change. */
  zoomLevel: number;
}

const ZOOM_KEY = "window.zoomLevel";
const MIN_ZOOM = -5;
const MAX_ZOOM = 9;

export function zoomFactor(level: number): number {
  return Math.pow(1.2, level);
}

/**
 * Window chrome state for the custom (undecorated) title bar: minimize /
 * maximize-restore / close, full screen, and whole-window zoom (persisted).
 */
export class WindowService {
  private state: WindowState = { maximized: false, fullscreen: false, zoomLevel: 0 };
  private closeHookInstalled = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: WindowApi,
    private readonly ipc: IpcClient,
    private readonly beforeClose: (() => Promise<boolean>) | null = null,
  ) {}

  getState(): WindowState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Loads the saved zoom and starts tracking maximize/fullscreen; returns a teardown function. */
  async initialize(): Promise<() => void> {
    const saved = await this.ipc.settingsGet(ZOOM_KEY).catch(() => null);
    const level = saved === null ? 0 : Number.parseInt(saved, 10);
    if (Number.isFinite(level) && level !== 0) {
      await this.applyZoom(level);
    }
    await this.syncFrameState();
    const stopResize = await this.api.onResized(() => { void this.syncFrameState(); });
    let stopClose: () => void = () => undefined;
    try {
      const beforeClose = this.beforeClose;
      if (this.api.onCloseRequested && beforeClose) {
        const off = await this.api.onCloseRequested(async event => {
          try { if (!(await beforeClose())) event.preventDefault(); }
          catch { event.preventDefault(); }
        });
        this.closeHookInstalled = true;
        stopClose = () => { this.closeHookInstalled = false; off(); };
      }
    } catch (error) { stopResize(); throw error; }
    return () => { stopClose(); stopResize(); };
  }

  minimize(): Promise<void> {
    return this.api.minimize();
  }

  toggleMaximize(): Promise<void> {
    return this.api.toggleMaximize();
  }

  async close(): Promise<void> {
    if (!this.closeHookInstalled && this.beforeClose && !(await this.beforeClose())) return;
    await this.api.close();
  }

  async toggleFullscreen(): Promise<void> {
    await this.api.setFullscreen(!this.state.fullscreen);
    await this.syncFrameState();
  }

  zoomIn(): Promise<void> {
    return this.setZoomLevel(this.state.zoomLevel + 1);
  }

  zoomOut(): Promise<void> {
    return this.setZoomLevel(this.state.zoomLevel - 1);
  }

  zoomReset(): Promise<void> {
    return this.setZoomLevel(0);
  }

  private async setZoomLevel(level: number): Promise<void> {
    await this.applyZoom(level);
    await this.ipc.settingsSet(ZOOM_KEY, String(this.state.zoomLevel)).catch(() => undefined);
  }

  private async applyZoom(level: number): Promise<void> {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(level)));
    await this.api.setZoom(zoomFactor(clamped));
    this.update({ zoomLevel: clamped });
  }

  private async syncFrameState(): Promise<void> {
    const [maximized, fullscreen] = await Promise.all([
      this.api.isMaximized(),
      this.api.isFullscreen(),
    ]);
    if (maximized !== this.state.maximized || fullscreen !== this.state.fullscreen) {
      this.update({ maximized, fullscreen });
    }
  }

  private update(patch: Partial<WindowState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

