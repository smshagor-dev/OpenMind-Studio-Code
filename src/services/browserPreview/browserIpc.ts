import { invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/commands/live_preview.rs (serde camelCase).

/** Where the built-in browser goes for a file. */
export interface LivePreviewTarget {
  /** `http://127.0.0.1:<port>`: messages from the page must come from here. */
  origin: string;
  url: string;
  /** The address inside the server (`/index.html`). */
  path: string;
  /** The folder the server serves. */
  root: string;
}

export interface BrowserIpc {
  livePreviewOpen: (file: string) => Promise<LivePreviewTarget>;
  openExternalUrl: (url: string) => Promise<void>;
}

export const tauriBrowserIpc: BrowserIpc = {
  livePreviewOpen: (file) => invoke<LivePreviewTarget>("live_preview_open", { file }),
  openExternalUrl: (url) => invoke("open_external_url", { url }),
};
