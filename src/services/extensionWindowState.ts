import { getCurrentWindow } from "@tauri-apps/api/window";

export interface WindowFocusSource {
  isFocused: () => Promise<boolean>;
  onFocusChanged: (listener: (focused: boolean) => void) => Promise<() => void>;
}

export const nativeWindowFocus: WindowFocusSource = {
  isFocused: () => getCurrentWindow().isFocused(),
  onFocusChanged: listener => getCurrentWindow().onFocusChanged(event => { listener(event.payload); }),
};

/** Keeps OS focus current across asynchronous listener registration and initial sampling. */
export class ExtensionWindowState {
  focused = false;
  private epoch = 0;
  private revision = 0;
  private off: (() => void) | undefined;

  constructor(private readonly source: WindowFocusSource, private readonly changed: (focused: boolean) => void) {}

  async start(): Promise<void> {
    this.stop();
    const epoch = this.epoch;
    const update = (focused: boolean) => {
      if (epoch !== this.epoch || typeof focused !== "boolean") return;
      this.revision++;
      if (this.focused === focused) return;
      this.focused = focused;
      this.changed(focused);
    };
    try {
      const off = await this.source.onFocusChanged(update);
      if (epoch !== this.epoch) { off(); return; }
      this.off = off;
      const revision = this.revision;
      const focused = await this.source.isFocused();
      if (revision === this.revision) update(focused);
    } catch (error) {
      if (epoch === this.epoch) this.stop();
      throw error;
    }
  }

  stop(): void {
    this.epoch++;
    this.off?.();
    this.off = undefined;
  }
}
