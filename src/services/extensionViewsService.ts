import type { ExtensionHostService } from "./extensionHostService";
import type { ExtensionRegistryService } from "./extensionRegistryService";
import type {
  ExtensionViewContainer,
  ExtensionViewContribution,
  ExtensionsIpc,
} from "./extensionsIpc";
import { evaluateWhen, type WhenContext } from "./whenClause";

/** A side bar view id for an extension's activity bar container: `ext:<extension id>/<container id>`. */
export type ExtensionSideView = `ext:${string}`;

export function containerKey(extensionId: string, containerId: string): ExtensionSideView {
  return `ext:${extensionId}/${containerId}`;
}

export function isExtensionView(view: string): view is ExtensionSideView {
  return view.startsWith("ext:");
}

/** One activity bar icon an enabled extension contributes. */
export interface ContainerEntry {
  key: ExtensionSideView;
  extensionId: string;
  extensionName: string;
  container: ExtensionViewContainer;
}

/** A tree item as the host describes it (the element itself stays in the host, behind `handle`). */
export interface TreeNode {
  handle: string;
  label: string;
  description: string | null;
  tooltip: string | null;
  /** 0 = leaf, 1 = collapsed, 2 = expanded. */
  collapsible: 0 | 1 | 2;
  icon: { theme?: string; file?: string } | null;
  hasCommand: boolean;
}

export interface TreeViewState {
  /** An activated extension registered a data provider for it. */
  registered: boolean;
  roots: TreeNode[] | null;
  children: Record<string, TreeNode[]>;
  expanded: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  message: string | null;
  description: string | null;
}

const EMPTY_VIEW: TreeViewState = {
  registered: false,
  roots: null,
  children: {},
  expanded: {},
  loading: false,
  error: null,
  message: null,
  description: null,
};

/** A line of `viewsWelcome` text: words with links, or a line that is only a command link (a button). */
export type WelcomeLine =
  | { kind: "text"; parts: ({ text: string } | { link: string; target: string })[] }
  | { kind: "button"; label: string; command: string };

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseWelcome(text: string): WelcomeLine[] {
  const lines: WelcomeLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    const only = /^\[([^\]]+)\]\(command:([^)\s]+)\)$/.exec(line);
    if (only) {
      lines.push({
        kind: "button",
        label: only[1] ?? "",
        command: (only[2] ?? "").split("?")[0] ?? "",
      });
      continue;
    }
    const parts: ({ text: string } | { link: string; target: string })[] = [];
    let last = 0;
    for (const match of line.matchAll(LINK)) {
      if (match.index > last) parts.push({ text: line.slice(last, match.index) });
      parts.push({ link: match[1] ?? "", target: match[2] ?? "" });
      last = match.index + match[0].length;
    }
    if (last < line.length) parts.push({ text: line.slice(last) });
    lines.push({ kind: "text", parts });
  }
  return lines;
}

export interface ExtensionViewsDeps {
  ipc: Pick<ExtensionsIpc, "extHostRequest" | "extReadIcon">;
  registry: Pick<ExtensionRegistryService, "all" | "subscribe">;
  host: Pick<ExtensionHostService, "activateFor" | "request">;
  /** Runs a command (a welcome button, a `command:` link). */
  run: (command: string) => void;
  onError: (message: string) => void;
  /** Context keys for `when` clauses (`workbenchState`, `workspaceFolderCount`). */
  context?: () => WhenContext;
}

/**
 * Extension views, VS Code style: every enabled extension's `viewsContainers.activitybar` entry is an
 * activity bar icon; opening it wakes the extension (`onView:<id>`) and shows its tree views, whose items
 * come from the extension's `TreeDataProvider` in the host (`host/tree`). Webview views (Milestone 18) are filled by
 * the extension's `WebviewViewProvider` when first shown and drawn in a sandboxed frame. UI-free.
 */
export class ExtensionViewsService {
  private views = new Map<string, TreeViewState>();
  private icons = new Map<string, string | null>();
  private open = new Set<string>();
  /** Why a container's extension failed to activate the last time it was shown. */
  private failures = new Map<string, string>();
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private cachedContainers: ContainerEntry[] = [];
  private cachedFrom: unknown = null;

  constructor(private readonly deps: ExtensionViewsDeps) {
    deps.registry.subscribe(() => {
      this.notify();
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Changes whenever anything shown changed (for `useSyncExternalStore`). */
  getVersion(): number {
    return this.version;
  }

  /** The activity bar icons, in install order, of enabled extensions only. */
  containers(): ContainerEntry[] {
    const all = this.deps.registry.all();
    if (all === this.cachedFrom) return this.cachedContainers;
    this.cachedFrom = all;
    this.cachedContainers = all
      .filter((extension) => extension.enabled)
      .flatMap((extension) =>
        extension.manifest.contributes.views.containers.map((container) => ({
          key: containerKey(extension.id, container.id),
          extensionId: extension.id,
          extensionName: extension.manifest.displayName ?? extension.manifest.name,
          container,
        })),
      );
    return this.cachedContainers;
  }

  find(key: string): ContainerEntry | undefined {
    return this.containers().find((entry) => entry.key === key);
  }

  /** The container's icon as a `data:` URL once loaded; `null` means "use the default icon". */
  iconOf(entry: ContainerEntry): string | null {
    const icon = entry.container.icon;
    if (icon === null || icon.startsWith("$(")) return null;
    return this.loadIcon(entry.extensionId, icon);
  }

  /** A tree item's file icon (inside the extension) as a `data:` URL, once loaded. */
  fileIcon(extensionId: string, file: string): string | null {
    return this.loadIcon(extensionId, file);
  }

  /** The `viewsWelcome` text whose `when` holds right now (all of them, joined), or `null`. */
  welcomeFor(view: ExtensionViewContribution): string | null {
    const context = this.deps.context?.() ?? {};
    const texts = view.welcome
      .filter((entry) => evaluateWhen(entry.when, context))
      .map((entry) => entry.contents);
    return texts.length === 0 ? null : texts.join("\n");
  }

  view(viewId: string): TreeViewState {
    return this.views.get(viewId) ?? EMPTY_VIEW;
  }

  /** The side bar shows `key`: wake its extension and load its trees. */
  async show(key: string): Promise<void> {
    const entry = this.find(key);
    if (!entry) return;
    this.open.add(key);
    this.failures.delete(key);
    // One extension owns every view here: once its activation failed, don't try again per view.
    for (const view of entry.container.views) {
      const results = await this.deps.host.activateFor({ kind: "view", view: view.id });
      const failed = results.find((result) => !result.ok);
      if (failed) {
        this.failures.set(key, failed.error ?? `Activating ${failed.id} failed.`);
        this.notify();
        return;
      }
    }
    await Promise.all([
      ...entry.container.views
        .filter((view) => view.kind === "tree" && this.view(view.id).registered)
        .map((view) => this.loadRoots(view.id)),
      ...entry.container.views
        .filter((view) => view.kind === "webview")
        .map((view) => this.resolveWebview(view.id)),
    ]);
  }

  /**
   * A webview view is shown: its provider fills it now (`host/resolveWebviewView`), never before. A view nobody
   * provides stays empty with a note; a failing provider shows its error.
   */
  private async resolveWebview(viewId: string): Promise<void> {
    try {
      const answer = (await this.deps.host.request("host/resolveWebviewView", { view: viewId })) as {
        id?: string | null;
      } | null;
      this.patch(viewId, {
        registered: typeof answer?.id === "string",
        error: null,
      });
    } catch (error) {
      this.patch(viewId, { error: String(error).replace(/^Error: /, "") });
    }
  }

  /** Why the extension behind `key` couldn't start, from the last time the container was shown. */
  failureOf(key: string): string | null {
    return this.failures.get(key) ?? null;
  }

  hide(key: string): void {
    this.open.delete(key);
  }

  async toggle(viewId: string, node: TreeNode): Promise<void> {
    if (node.collapsible === 0) return;
    const state = this.view(viewId);
    const expanded = !this.isExpanded(viewId, node);
    this.patch(viewId, { expanded: { ...state.expanded, [node.handle]: expanded } });
    void this.request(viewId, expanded ? "expand" : "collapse", node.handle).catch(() => undefined);
    if (expanded && state.children[node.handle] === undefined)
      await this.loadChildren(viewId, node.handle);
  }

  isExpanded(viewId: string, node: TreeNode): boolean {
    const set = this.view(viewId).expanded[node.handle];
    return set ?? node.collapsible === 2;
  }

  /** A click: runs the item's command, or opens/closes a parent without one (VS Code). */
  async click(viewId: string, node: TreeNode): Promise<void> {
    if (!node.hasCommand && node.collapsible !== 0) {
      await this.toggle(viewId, node);
      return;
    }
    try {
      await this.request(viewId, "click", node.handle);
    } catch (error) {
      this.deps.onError(String(error).replace(/^Error: /, ""));
    }
  }

  collapseAll(viewId: string): void {
    this.patch(viewId, {
      expanded: Object.fromEntries(Object.keys(this.view(viewId).children).map((h) => [h, false])),
    });
  }

  async refresh(viewId: string): Promise<void> {
    await this.loadRoots(viewId);
  }

  runCommand(command: string): void {
    this.deps.run(command);
  }

  /** The host's `views/*` notifications (and `views/reset` when the host went away). */
  handleEvent(method: string, params: Record<string, unknown>): void {
    const viewId = typeof params.view === "string" ? params.view : "";
    switch (method) {
      case "views/registered":
        this.patch(viewId, { registered: true, error: null });
        if (this.isVisible(viewId)) void this.loadRoots(viewId);
        return;
      case "views/unregistered":
        this.views.delete(viewId);
        this.notify();
        return;
      case "views/changed": {
        const handle = typeof params.handle === "string" ? params.handle : null;
        if (handle === null || this.view(viewId).roots === null) void this.loadRoots(viewId);
        else void this.loadChildren(viewId, handle);
        return;
      }
      case "views/message":
        this.patch(viewId, { message: typeof params.message === "string" ? params.message : null });
        return;
      case "views/title":
        this.patch(viewId, {
          description: typeof params.description === "string" ? params.description : null,
        });
        return;
      case "views/reset":
        this.views.clear();
        this.notify();
        return;
      default:
    }
  }

  private isVisible(viewId: string): boolean {
    return [...this.open].some((key) =>
      this.find(key)?.container.views.some((view) => view.id === viewId),
    );
  }

  private async loadRoots(viewId: string): Promise<void> {
    this.patch(viewId, { loading: true, error: null });
    try {
      const roots = (await this.request(viewId, "children", null)) as TreeNode[];
      const state = this.view(viewId);
      // Children of parents that are still open are fetched again; the rest are forgotten.
      const children: Record<string, TreeNode[]> = {};
      this.patch(viewId, { roots, children, loading: false });
      const openParents = roots.filter(
        (node) => state.expanded[node.handle] ?? node.collapsible === 2,
      );
      await Promise.all(openParents.map((node) => this.loadChildren(viewId, node.handle)));
    } catch (error) {
      this.patch(viewId, { loading: false, error: String(error).replace(/^Error: /, "") });
    }
  }

  private async loadChildren(viewId: string, handle: string): Promise<void> {
    try {
      const nodes = (await this.request(viewId, "children", handle)) as TreeNode[];
      const state = this.view(viewId);
      this.patch(viewId, { children: { ...state.children, [handle]: nodes } });
      const open = nodes.filter((node) => state.expanded[node.handle] ?? node.collapsible === 2);
      await Promise.all(open.map((node) => this.loadChildren(viewId, node.handle)));
    } catch (error) {
      this.patch(viewId, { error: String(error).replace(/^Error: /, "") });
    }
  }

  private request(view: string, op: string, handle: string | null): Promise<unknown> {
    return this.deps.ipc.extHostRequest("host/tree", { view, op, handle });
  }

  private loadIcon(extensionId: string, file: string): string | null {
    const cacheKey = `${extensionId}/${file}`;
    if (this.icons.has(cacheKey)) return this.icons.get(cacheKey) ?? null;
    this.icons.set(cacheKey, null);
    void this.deps.ipc.extReadIcon(extensionId, file).then(
      (url) => {
        this.icons.set(cacheKey, url);
        this.notify();
      },
      () => undefined, // a missing or unsupported icon falls back to the default one
    );
    return null;
  }

  private patch(viewId: string, patch: Partial<TreeViewState>): void {
    this.views.set(viewId, { ...this.view(viewId), ...patch });
    this.notify();
  }

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
