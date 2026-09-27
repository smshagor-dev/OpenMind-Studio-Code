import { RESOURCE_SCHEME } from "./webviewHtml";

/** One webview an extension opened: a panel over the editors, or a view in its side bar container. */
export interface WebviewPanelView {
  id: string;
  extension: string;
  /** `panel` (`createWebviewPanel`) or `view` (a webview view, Milestone 18). */
  placement: "panel" | "view";
  /** The contributed view id, for a view. */
  view: string | null;
  viewType: string;
  title: string;
  /** A view's description (shown next to its title). */
  description: string;
  html: string;
  enableScripts: boolean;
  /** Keep the page alive while another tab is shown (`retainContextWhenHidden`). */
  retain: boolean;
  /** Absolute local resource roots the host checked; the backend checks them again. */
  roots: string[];
  /** The page's last `setState` value (JSON text). */
  state: string | null;
  /** What was left out of the page and why. */
  blocked: string[];
}

export interface WebviewState {
  /** Every webview, panels and views alike (`panelsOf` / `viewFor` pick them). */
  panels: WebviewPanelView[];
  /** Views whose extension registered a webview view provider. */
  providers: string[];
  activeId: string | null;
  /** The panels cover the editor area; hidden with "Editors", the panels stay alive. */
  overlay: boolean;
  /** Goes up whenever a panel should take the keyboard focus (opened, revealed, chosen). */
  focusSeq: number;
}

export interface WebviewDeps {
  /** A notification to the extension host (`host/webview*`). */
  notifyHost: (method: string, params: unknown) => void;
  /** The backend reading a local file for a webview (see `ext_webview_read_resource`). */
  readResource: (extension: string, path: string, roots: string[]) => Promise<string>;
  log?: (line: string) => void;
  onError?: (message: string) => void;
  /** A webview view asked to be shown (`WebviewView.show`): reveal its side bar container. */
  revealView?: (view: string) => void;
}

/** The webviews shown over the editors (not the side bar views). */
export function panelsOf(state: WebviewState): WebviewPanelView[] {
  return state.panels.filter((panel) => panel.placement === "panel");
}

/** More panels than this are refused (each one is a page). */
export const MAX_PANELS = 20;
/** A message from a page or to it may not be larger than this (JSON text). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Limits on what an extension may set on a panel. */
export const MAX_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_TITLE_LENGTH = 200;
export const MAX_VIEW_TYPE_LENGTH = 100;
/** The saved page state (`setState`) of one panel may not be larger than this (JSON text). */
export const MAX_STATE_BYTES = 1024 * 1024;

const INITIAL: WebviewState = { panels: [], providers: [], activeId: null, overlay: true, focusSeq: 0 };

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `openmind-webview-resource://panel/<base64url path>` back to the path (`null` when it isn't one). */
export function resourcePath(uri: string): string | null {
  const prefix = `${RESOURCE_SCHEME}//panel/`;
  if (!uri.toLowerCase().startsWith(prefix)) return null;
  const encoded = uri.slice(prefix.length).split(/[?#]/)[0] ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The webview panels of extensions: their state (title, HTML, options), the messages between an extension and
 * its page, and their life cycle. A panel belongs to one extension (its id starts with the extension id) and
 * only that extension's events change it. Panels go when the user closes them, when the extension is disabled
 * or uninstalled, and when the extension host stops, crashes or restarts. UI-free; the page itself is drawn by
 * `WebviewPanels` in a sandboxed frame.
 */
export class WebviewService {
  private state: WebviewState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly messageListeners = new Set<(id: string, json: string) => void>();

  constructor(private readonly deps: WebviewDeps) {}

  /** Where `WebviewView.show` goes (the side bar reveals the view's container). */
  onRevealView(reveal: (view: string) => void): void {
    this.deps.revealView = reveal;
  }

  getState(): WebviewState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The frame of a panel listens here for messages from its extension. */
  onMessageToPage(listener: (id: string, json: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  find(id: string): WebviewPanelView | undefined {
    return this.state.panels.find((panel) => panel.id === id);
  }

  /** The webview of a contributed view, once its provider filled it. */
  viewFor(view: string): WebviewPanelView | undefined {
    return this.state.panels.find((panel) => panel.placement === "view" && panel.view === view);
  }

  /** Whether an activated extension registered a provider for `view`. */
  hasProvider(view: string): boolean {
    return this.state.providers.includes(view);
  }

  /** The side bar shows (or hides) a webview view: its extension hears `onDidChangeVisibility`. */
  setViewVisible(id: string, visible: boolean): void {
    const panel = this.find(id);
    if (panel?.placement !== "view") return;
    this.deps.notifyHost("host/webviewViewState", { id, visible, active: visible });
  }

  /** The host's `webview/*` notifications, and `webview/reset` when the host went away. */
  handleEvent(method: string, params: Record<string, unknown>): void {
    const id = str(params.id);
    const extension = str(params.extension);
    if (method === "webview/reset") {
      this.reset();
      return;
    }
    if (method === "webview/viewProvider") {
      const view = str(params.view);
      if (view === "" || extension === "") return;
      const others = this.state.providers.filter((known) => known !== view);
      this.set({ providers: params.registered === true ? [...others, view] : others });
      return;
    }
    if (id === "" || extension === "" || !id.startsWith(`${extension}#`)) return;
    if (method === "webview/create") {
      this.create(id, extension, params);
      return;
    }
    const panel = this.find(id);
    if (!panel || panel.extension !== extension) return;
    switch (method) {
      case "webview/html": {
        const html = str(params.html);
        if (byteLength(html) > MAX_HTML_BYTES) {
          this.deps.onError?.(`${extension} set webview HTML larger than 5 MB; it was ignored.`);
          return;
        }
        this.patch(id, { html, blocked: [] });
        return;
      }
      case "webview/title":
        this.patch(id, { title: clip(str(params.title), MAX_TITLE_LENGTH) });
        return;
      case "webview/description":
        this.patch(id, { description: clip(str(params.description), MAX_TITLE_LENGTH) });
        return;
      case "webview/revealView":
        if (panel.view !== null) this.deps.revealView?.(panel.view);
        return;
      case "webview/options":
        this.patch(id, {
          enableScripts: params.enableScripts === true,
          roots: Array.isArray(params.roots) ? params.roots.map(str) : panel.roots,
        });
        return;
      case "webview/postMessage": {
        const json = str(params.message);
        if (byteLength(json) > MAX_MESSAGE_BYTES) return;
        for (const listener of this.messageListeners) listener(id, json);
        return;
      }
      case "webview/reveal":
        this.reveal(id);
        return;
      case "webview/dispose":
        this.remove(id, false);
    }
  }

  private create(id: string, extension: string, params: Record<string, unknown>): void {
    if (this.find(id)) return;
    const placement = params.placement === "view" ? "view" : "panel";
    const view = placement === "view" ? str(params.view) : null;
    if (placement === "view" && (view === "" || this.viewFor(view ?? ""))) return;
    if (placement === "panel" && panelsOf(this.state).length >= MAX_PANELS) {
      this.deps.onError?.(
        `${extension} tried to open more than ${String(MAX_PANELS)} webview panels.`,
      );
      this.deps.notifyHost("host/webviewDisposed", { id });
      return;
    }
    const panel: WebviewPanelView = {
      id,
      extension,
      placement,
      view,
      viewType: clip(str(params.viewType), MAX_VIEW_TYPE_LENGTH),
      title: clip(str(params.title), MAX_TITLE_LENGTH),
      description: "",
      html: "",
      enableScripts: params.enableScripts === true,
      retain: params.retain === true,
      roots: Array.isArray(params.roots) ? params.roots.map(str) : [],
      state: null,
      blocked: [],
    };
    if (placement === "view") {
      // A view lives in the side bar: it never covers the editors or takes the panel tabs' focus.
      this.set({ panels: [...this.state.panels, panel] });
      return;
    }
    this.set({ panels: [...this.state.panels, panel], overlay: true });
    if (params.preserveFocus !== true || this.state.activeId === null) this.setActive(id);
    else this.deps.notifyHost("host/webviewViewState", { id, visible: false, active: false });
  }

  /** The user closes a tab: the panel goes and the extension hears `onDidDispose`. */
  close(id: string): void {
    this.remove(id, true);
  }

  private remove(id: string, tellHost: boolean): void {
    if (!this.find(id)) return;
    const panels = this.state.panels.filter((panel) => panel.id !== id);
    const remaining = panels.filter((panel) => panel.placement === "panel");
    const activeId =
      this.state.activeId === id ? (remaining[remaining.length - 1]?.id ?? null) : this.state.activeId;
    this.set({ panels, activeId });
    if (tellHost) this.deps.notifyHost("host/webviewDisposed", { id });
    if (activeId !== null) this.announce(activeId);
  }

  setActive(id: string): void {
    if (this.find(id)?.placement !== "panel") return;
    const previous = this.state.activeId;
    this.set({ activeId: id, overlay: true, focusSeq: this.state.focusSeq + 1 });
    if (previous !== null && previous !== id && this.find(previous)) {
      this.deps.notifyHost("host/webviewViewState", {
        id: previous,
        visible: false,
        active: false,
      });
    }
    this.announce(id);
  }

  private announce(id: string): void {
    this.deps.notifyHost("host/webviewViewState", {
      id,
      visible: this.state.overlay,
      active: this.state.activeId === id && this.state.overlay,
    });
  }

  private reveal(id: string): void {
    this.setActive(id);
  }

  /** "Editors" hides the panels without closing them; a panel comes back with `setActive` or `showOverlay`. */
  hideOverlay(): void {
    this.set({ overlay: false });
    for (const panel of panelsOf(this.state)) {
      this.deps.notifyHost("host/webviewViewState", {
        id: panel.id,
        visible: false,
        active: false,
      });
    }
  }

  showOverlay(): void {
    if (panelsOf(this.state).length === 0) return;
    this.set({ overlay: true });
    if (this.state.activeId !== null) this.announce(this.state.activeId);
  }

  /** A message from a page: JSON text, at most 1 MB, and only for a panel that exists. */
  receive(id: string, json: string): void {
    if (!this.find(id)) return;
    if (byteLength(json) > MAX_MESSAGE_BYTES) {
      this.deps.onError?.("A webview sent a message larger than 1 MB; it was dropped.");
      return;
    }
    try {
      JSON.parse(json);
    } catch {
      return;
    }
    this.deps.notifyHost("host/webviewMessage", { id, message: json });
  }

  /** The page's `setState` value, kept so a re-drawn page gets it back from `getState`. */
  setPageState(id: string, json: string): void {
    if (!this.find(id)) return;
    if (byteLength(json) > MAX_STATE_BYTES) {
      this.deps.onError?.("A webview's saved state is larger than 1 MB; it was not kept.");
      return;
    }
    try {
      JSON.parse(json);
    } catch {
      return;
    }
    this.patch(id, { state: json });
  }

  /** What the sanitizer left out of a panel's page. */
  recordBlocked(id: string, blocked: string[]): void {
    const panel = this.find(id);
    if (!panel || JSON.stringify(panel.blocked) === JSON.stringify(blocked)) return;
    this.patch(id, { blocked });
    for (const line of blocked)
      this.deps.log?.(`[${panel.extension}] webview "${panel.title}": ${line}`);
  }

  /** A local file for the page of panel `id`, as a `data:` URL (the backend checks roots, type and size). */
  async readResource(id: string, uri: string): Promise<string> {
    const panel = this.find(id);
    if (!panel) throw new Error("This webview is closed.");
    const path = resourcePath(uri);
    if (path === null) throw new Error(`Not a webview resource address: ${uri}`);
    return this.deps.readResource(panel.extension, path, panel.roots);
  }

  /** Extensions that are gone or disabled lose their panels (the host closes its side by deactivating them). */
  keepOnly(enabledExtensions: ReadonlySet<string>): void {
    const keep = this.state.panels.filter((panel) => enabledExtensions.has(panel.extension));
    if (keep.length === this.state.panels.length) return;
    const keptPanels = keep.filter((panel) => panel.placement === "panel");
    const activeId = keptPanels.some((p) => p.id === this.state.activeId)
      ? this.state.activeId
      : (keptPanels[keptPanels.length - 1]?.id ?? null);
    this.set({ panels: keep, activeId });
  }

  /** The host went away (stopped, crashed, restarting): every panel it made is gone with it. */
  reset(): void {
    if (this.state.panels.length === 0 && this.state.activeId === null && this.state.providers.length === 0) {
      return;
    }
    this.set({ panels: [], activeId: null, providers: [] });
  }

  private patch(id: string, change: Partial<WebviewPanelView>): void {
    this.set({
      panels: this.state.panels.map((panel) => (panel.id === id ? { ...panel, ...change } : panel)),
    });
  }

  private set(change: Partial<WebviewState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}
