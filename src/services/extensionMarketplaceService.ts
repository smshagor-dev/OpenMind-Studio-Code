import type { MarketDetails, MarketItem, MarketplaceApi, MarketSort } from "./marketplaceIpc";

/** VS Code's compact install counts: 950, 1.2K, 86.5M. */
export function formatCount(count: number): string {
  const short = (value: number, unit: string) =>
    `${value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "")}${unit}`;
  if (count >= 1_000_000_000) return short(count / 1_000_000_000, "B");
  if (count >= 1_000_000) return short(count / 1_000_000, "M");
  if (count >= 1_000) return short(count / 1_000, "K");
  return String(count);
}

/** The id an installed extension has for a marketplace entry (`publisher.name`, lower-case). */
export function marketId(namespace: string, name: string): string {
  return `${namespace}.${name}`.toLowerCase();
}

/** Whether `latest` is a newer version than `current` (numeric dotted parts; a pre-release is older than its release). */
export function isNewerVersion(latest: string, current: string): boolean {
  const split = (version: string) => {
    const [core = "", pre] = version.trim().replace(/^v/i, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre: pre ?? null };
  };
  const a = split(latest);
  const b = split(current);
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i += 1) {
    const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return a.pre === null && b.pre !== null;
}

/** An installed extension Open VSX has a newer version of. */
export interface UpdateInfo {
  id: string;
  namespace: string;
  name: string;
  current: string;
  latest: string;
}

/** What the update check needs to know about an installed extension. */
export interface InstalledForUpdate {
  id: string;
  publisher: string;
  name: string;
  version: string;
}

export type ExtensionPageTab = "details" | "features" | "changelog";

/** The extension page shown over the editor area (VS Code's extension editor). */
export interface ExtensionPage {
  namespace: string;
  name: string;
  /** Set when the extension is installed (its local id). */
  installedId: string | null;
  details: MarketDetails | null;
  loading: boolean;
  /** Why Open VSX has no page for it (e.g. installed from a local .vsix). */
  error: string | null;
  tab: ExtensionPageTab;
  readme: string | null;
  changelog: string | null;
  textLoading: boolean;
  textError: string | null;
}

export interface MarketplaceState {
  query: string;
  sort: MarketSort;
  items: MarketItem[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** Extensions being downloaded, by id, with what is happening. */
  installing: Record<string, string>;
  page: ExtensionPage | null;
  /** Whether the user has asked the marketplace for anything yet (nothing is fetched before that). */
  requested: boolean;
  /** Installed extensions with a newer version on Open VSX (after a check). */
  updates: UpdateInfo[];
  checkingUpdates: boolean;
  /** When updates were last checked (null: never in this session). */
  updatesCheckedAt: string | null;
  updateError: string | null;
}

const PAGE_SIZE = 30;
const DEBOUNCE_MS = 300;

const INITIAL: MarketplaceState = {
  query: "",
  sort: "relevance",
  items: [],
  total: 0,
  loading: false,
  loadingMore: false,
  error: null,
  installing: {},
  page: null,
  requested: false,
  updates: [],
  checkingUpdates: false,
  updatesCheckedAt: null,
  updateError: null,
};

export interface MarketplaceHooks {
  /** Hands a downloaded `.vsix` to the normal install flow (trust dialog, then install). */
  install: (path: string) => Promise<void>;
  onError: (message: string) => void;
  /** `extensions.marketplace.autoFetch`: load Popular when the view shows. On by default; the user can turn it off. */
  autoFetch?: () => boolean;
  /** The installed extensions, for the update check (Milestone 18). */
  installed?: () => InstalledForUpdate[];
  /** False while the app is still starting: a view shown then (restored) doesn't auto-load anything. */
  startupFinished?: () => boolean;
}

/**
 * The Extensions view's marketplace: Open VSX search (debounced; only the
 * newest answer is kept), an empty search listing the most installed
 * extensions like VS Code's "Popular", paging, the extension page with its
 * README and CHANGELOG, and Install — a checksum-verified download handed to
 * the existing trust-and-install flow. Everything listed comes from the API.
 */
export class ExtensionMarketplaceService {
  private state: MarketplaceState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private token = 0;
  private pageToken = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    private readonly api: MarketplaceApi,
    private readonly hooks: MarketplaceHooks,
  ) {}

  getState(): MarketplaceState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The first time the user opens the view after start-up. Nothing is fetched (no network call) unless
   * `extensions.marketplace.autoFetch` is on, and never for a view restored at launch; otherwise the view offers "Load Popular".
   */
  start(): void {
    if (this.started) return;
    // A view restored at launch waits for the user (Load Popular / Check for Updates): nothing is fetched at start-up.
    if (this.hooks.startupFinished?.() === false) return;
    this.started = true;
    if (this.hooks.autoFetch?.() === true) {
      void this.refresh();
      void this.checkUpdates();
    }
  }

  /**
   * Asks Open VSX for the newest version of every installed extension that came from a publisher (a local `.vsix`
   * without one is skipped). Only on the user's request or when the Extensions view opens with auto-load on — never at
   * launch, and nothing is downloaded: Update goes through the normal install (checksum, trust dialog).
   */
  async checkUpdates(): Promise<void> {
    if (this.state.checkingUpdates) return;
    const candidates = (this.hooks.installed?.() ?? []).filter(
      (extension) => extension.publisher !== "" && extension.publisher.toLowerCase() !== "local",
    );
    this.set({ checkingUpdates: true, updateError: null });
    const updates: UpdateInfo[] = [];
    let failures = 0;
    for (const extension of candidates) {
      try {
        const details = await this.api.details(extension.publisher, extension.name);
        if (isNewerVersion(details.version, extension.version)) {
          updates.push({
            id: extension.id,
            namespace: details.namespace,
            name: details.name,
            current: extension.version,
            latest: details.version,
          });
        }
      } catch {
        // Not on Open VSX (or a network error): no update for it.
        failures += 1;
      }
    }
    this.set({
      checkingUpdates: false,
      updates,
      updatesCheckedAt: new Date().toLocaleTimeString(),
      updateError:
        candidates.length > 0 && failures === candidates.length
          ? "Open VSX couldn't be reached, or none of the installed extensions are published there."
          : null,
    });
  }

  /** The update of an installed extension, if the last check found one. */
  updateFor(id: string): UpdateInfo | undefined {
    return this.state.updates.find((update) => update.id === id.toLowerCase() || update.id === id);
  }

  /** The user's explicit "Load Popular" / "Browse Open VSX". */
  async browse(): Promise<void> {
    await this.refresh();
  }

  /** Search-as-you-type: waits for a pause in typing. */
  setQuery(query: string): void {
    this.set({ query });
    if (this.timer !== null) clearTimeout(this.timer);
    // Emptying the box before anything was requested is not a request.
    if (query.trim() === "" && !this.state.requested) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, DEBOUNCE_MS);
  }

  async setSort(sort: MarketSort): Promise<void> {
    this.set({ sort });
    if (this.state.requested) await this.refresh();
  }

  /** The Open VSX sort actually used: an empty search lists by install count (Popular). */
  effectiveSort(): MarketSort {
    return this.state.query.trim() === "" && this.state.sort === "relevance"
      ? "installs"
      : this.state.sort;
  }

  async refresh(): Promise<void> {
    const token = ++this.token;
    this.set({ loading: true, error: null, requested: true });
    try {
      const page = await this.api.search(this.state.query, this.effectiveSort(), 0, PAGE_SIZE);
      if (token !== this.token) return;
      this.set({ items: page.items, total: page.total, loading: false });
    } catch (error) {
      if (token !== this.token) return;
      this.set({ items: [], total: 0, loading: false, error: String(error) });
    }
  }

  hasMore(): boolean {
    return this.state.items.length < this.state.total;
  }

  async loadMore(): Promise<void> {
    if (!this.hasMore() || this.state.loadingMore || this.state.loading) return;
    const token = this.token;
    this.set({ loadingMore: true });
    try {
      const page = await this.api.search(
        this.state.query,
        this.effectiveSort(),
        this.state.items.length,
        PAGE_SIZE,
      );
      if (token !== this.token) return;
      const seen = new Set(this.state.items.map((i) => marketId(i.namespace, i.name)));
      const fresh = page.items.filter((i) => !seen.has(marketId(i.namespace, i.name)));
      this.set({ items: [...this.state.items, ...fresh], total: page.total, loadingMore: false });
    } catch (error) {
      if (token !== this.token) return;
      this.set({ loadingMore: false, error: String(error) });
    }
  }

  /** Opens the extension page; `installedId` for an installed one (it may not be on Open VSX). */
  async openPage(namespace: string, name: string, installedId: string | null): Promise<void> {
    const token = ++this.pageToken;
    this.set({
      page: {
        namespace,
        name,
        installedId,
        details: null,
        loading: true,
        error: null,
        tab: "details",
        readme: null,
        changelog: null,
        textLoading: false,
        textError: null,
      },
    });
    try {
      const details = await this.api.details(namespace, name);
      if (token !== this.pageToken) return;
      this.patchPage({ details, loading: false });
      await this.loadText("details");
    } catch (error) {
      if (token !== this.pageToken) return;
      this.patchPage({ loading: false, error: String(error) });
    }
  }

  closePage(): void {
    this.pageToken++;
    this.set({ page: null });
  }

  async setTab(tab: ExtensionPageTab): Promise<void> {
    this.patchPage({ tab });
    await this.loadText(tab);
  }

  /** Installed id of a list entry, from the ids the caller knows are installed. */
  installedIdOf(item: MarketItem, installed: ReadonlySet<string>): string | null {
    const id = marketId(item.namespace, item.name);
    return installed.has(id) ? id : null;
  }

  /** Downloads the extension and hands it to the trust dialog. */
  async install(namespace: string, name: string): Promise<void> {
    const id = marketId(namespace, name);
    if (id in this.state.installing) return;
    this.set({ installing: { ...this.state.installing, [id]: "Downloading…" } });
    try {
      const path = await this.api.download(namespace, name);
      this.set({ installing: { ...this.state.installing, [id]: "Installing…" } });
      await this.hooks.install(path);
    } catch (error) {
      this.hooks.onError(`Couldn't install ${namespace}.${name}: ${String(error)}`);
    } finally {
      this.set({
        installing: Object.fromEntries(
          Object.entries(this.state.installing).filter(([key]) => key !== id),
        ),
      });
    }
  }

  private async loadText(tab: ExtensionPageTab): Promise<void> {
    const page = this.state.page;
    if (page?.details === null || page === null || tab === "features") return;
    const url = tab === "details" ? page.details.readmeUrl : page.details.changelogUrl;
    const have = tab === "details" ? page.readme : page.changelog;
    if (url === null || have !== null) return;
    const token = this.pageToken;
    this.patchPage({ textLoading: true, textError: null });
    try {
      const text = await this.api.text(url);
      if (token !== this.pageToken) return;
      this.patchPage(
        tab === "details"
          ? { readme: text, textLoading: false }
          : { changelog: text, textLoading: false },
      );
    } catch (error) {
      if (token !== this.pageToken) return;
      this.patchPage({ textLoading: false, textError: String(error) });
    }
  }

  private patchPage(patch: Partial<ExtensionPage>): void {
    if (this.state.page === null) return;
    this.set({ page: { ...this.state.page, ...patch } });
  }

  private set(patch: Partial<MarketplaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
