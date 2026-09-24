import type { IpcClient } from "./ipc";

const SETTINGS_KEY = "editor.enablePreview";

/**
 * The "Enable Preview Editors" setting. With it on, a file opened by a single
 * click (from the Explorer, a search result) opens in a provisional tab that
 * the next such file replaces; editing it or double-clicking it keeps it.
 * The provisional flag itself lives on the tab in `EditorGroupService`; this
 * only owns whether the behavior is enabled (default on, like VS Code).
 */
export class PreviewEditorService {
  private enabled = true;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ipc: IpcClient) {}

  async initialize(): Promise<void> {
    const saved = await this.ipc.settingsGet(SETTINGS_KEY).catch(() => null);
    if (saved !== null) {
      this.enabled = saved !== "false";
      this.notify();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whether a file opened "as a preview" should really be provisional. */
  shouldOpenAsPreview(requested: boolean): boolean {
    return requested && this.enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.notify();
    await this.ipc.settingsSet(SETTINGS_KEY, String(enabled)).catch(() => undefined);
  }

  async toggle(): Promise<void> {
    await this.setEnabled(!this.enabled);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
