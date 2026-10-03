import {
  type CanonicalIpc,
  type Domain,
  type DomainData,
  type GlobalDomain,
  isWorkspaceDomain,
  type StateDelta,
  type StateSnapshot,
  WORKSPACE_DOMAINS,
  type WorkspaceDomain,
} from "./canonicalIpc";

/** How a store follows one global domain of the canonical state. */
export interface CanonicalFeed<T> {
  /** The latest state, or `undefined` while the backend hasn't read the domain yet (the store shows it as loading). */
  current: () => T | undefined;
  /** Called with every newer state of the domain. */
  subscribe: (listener: (data: T) => void) => () => void;
  /** Resolves once this window has applied every change the backend made so far (after an operation). */
  catchUp: () => Promise<void>;
  /** Resolves once the domain is here (start-up: the backend reads it in the background), or after a long wait. */
  ready: () => Promise<void>;
}

/** How a store follows one per-workspace domain: always the state of *this window's* open folder. */
export interface WorkspaceFeed<T> {
  /** Whether the window follows the canonical state (otherwise the store reads for itself). */
  active: () => boolean;
  /** The folder's state, or `undefined` while it isn't known (no folder, just opened, not read yet). */
  current: () => T | undefined;
  /** Called with every newer state; `undefined` when the window's folder changed or closed. */
  subscribe: (listener: (data: T | undefined) => void) => () => void;
  /** Asks the backend to read it again — once for every window on the folder asking at the same time — and waits. */
  refresh: () => Promise<void>;
}

type Listener = (data: never) => void;

/** How long `catchUp` waits for the deltas it is missing before it reads a fresh snapshot instead. */
const CATCH_UP_MS = 2000;
/** Gap recoveries in a row without one cleanly applied delta before the window stops trying (reported). */
const MAX_RESYNCS = 3;
/** How long `ready` waits for a domain's first state (the backend retries a failed start-up read meanwhile). */
const READY_MS = 15_000;

/**
 * The window's copy of the canonical, versioned Rust-side state (`src-tauri/src/state`). One per window; stores read
 * their domain through a feed, never the Tauri event themselves.
 *
 * Global domains are the same in every window. Per-workspace domains are kept only for this window's open folder
 * (`workspace`): another folder's delta arrives as a revision-only tick (or is treated as one), so every window still
 * sees every revision without other folders' data. Opening another folder clears the old folder's state and reads the
 * snapshot again.
 *
 * Start-up without a race: it listens for deltas *first*, holding them back, then attaches its folder and asks for
 * the snapshot (revision N), applies it, and only then applies the held deltas newer than N, in order. A delta at or
 * below the current revision is stale and dropped. Deltas are numbered without gaps, so one that skips a revision
 * means something was missed: the window reads a fresh snapshot (holding back what arrives meanwhile).
 */
export class CanonicalStateService {
  private revision = 0;
  private workspace: string | null = null;
  private held: StateDelta[] = [];
  private readonly data: Partial<DomainData> = {};
  private readonly listeners = new Map<Domain, Set<Listener>>();
  private waiters: { revision: number; resolve: () => void }[] = [];
  private resyncing: Promise<void> | null = null;
  private resyncsInARow = 0;
  private unlisten: (() => void) | null = null;
  private available = false;
  /** Gaps kept coming back and the window stopped following; a later catch-up or refresh tries once more. */
  private gaveUp = false;
  private disposed = false;
  /** The start-up bootstrap (listen, attach, first snapshot); `ready` waits for it. */
  private starting: Promise<void> = Promise.resolve();
  /** The folder attach in progress (calls are serialized). */
  private attaching: Promise<void> = Promise.resolve();

  constructor(
    private readonly ipc: CanonicalIpc,
    private readonly log: (line: string) => void = () => undefined,
    /** The window can't follow the backend's state any more (told once, so the UI can say so). */
    private readonly failed: (reason: string) => void = () => undefined,
  ) {}

  /** Starts following the backend. Safe to call once; a backend without canonical state leaves it inactive. */
  start(): Promise<void> {
    if (this.unlisten !== null || this.disposed) return this.starting;
    this.starting = this.bootstrap();
    return this.starting;
  }

  private async bootstrap(): Promise<void> {
    this.unlisten = await this.ipc.onDelta((delta) => {
      this.receive(delta);
    });
    await this.ipc.attach().catch(() => null);
    await this.resync();
  }

  /**
   * The window opened another folder, closed it, or got its first one: its per-workspace state follows. Calls run one
   * after another, so two quick folder switches can't finish in the wrong order and leave the window on the older one.
   */
  attachWorkspace(): Promise<void> {
    const next = this.attaching.then(() => this.attachNow());
    this.attaching = next.catch(() => undefined);
    return next;
  }

  private async attachNow(): Promise<void> {
    if (this.disposed || this.unlisten === null) return;
    const key = await this.ipc.attach().catch(() => this.workspace);
    if (key === this.workspace) return;
    this.setWorkspace(key);
    // Not a gap: a planned re-read, which doesn't count towards giving up.
    this.resyncsInARow = 0;
    await this.resync();
  }

  /** Whether the backend's canonical state is being followed (a snapshot was received). */
  active(): boolean {
    return this.available;
  }

  currentRevision(): number {
    return this.revision;
  }

  /** The window's folder key (`null` without a folder). */
  currentWorkspace(): string | null {
    return this.workspace;
  }

  get<D extends Domain>(domain: D): DomainData[D] | undefined {
    return this.data[domain];
  }

  on<D extends GlobalDomain>(domain: D, listener: (data: DomainData[D]) => void): () => void {
    return this.listen(domain, listener);
  }

  /** Every newer state of a per-workspace domain of this window's folder; `undefined` when the folder changed. */
  onWorkspace<D extends WorkspaceDomain>(
    domain: D,
    listener: (data: DomainData[D] | undefined) => void,
  ): () => void {
    return this.listen(domain, listener);
  }

  private listen(domain: Domain, listener: Listener): () => void {
    let set = this.listeners.get(domain);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(domain, set);
    }
    set.add(listener);
    return () => {
      this.listeners.get(domain)?.delete(listener);
    };
  }

  feed<D extends GlobalDomain>(domain: D): CanonicalFeed<DomainData[D]> {
    return {
      current: () => this.get(domain),
      subscribe: (listener) => this.on(domain, listener),
      catchUp: () => this.catchUp(),
      ready: () => this.whenPresent(domain),
    };
  }

  workspaceFeed<D extends WorkspaceDomain>(domain: D): WorkspaceFeed<DomainData[D]> {
    return {
      active: () => this.available,
      current: () => this.get(domain),
      subscribe: (listener) => this.onWorkspace(domain, listener),
      refresh: () => this.refresh([domain]),
    };
  }

  /** Asks the backend to bring `domains` up to date (shared reads), then waits until this window has the result. */
  async refresh(domains: Domain[]): Promise<void> {
    if (!this.available && !this.gaveUp) return;
    try {
      await this.ipc.refresh(domains);
    } catch (error) {
      this.log(`state: a refresh of ${domains.join(", ")} failed: ${String(error)}`);
    }
    await this.catchUp();
  }

  /** Resolves when `domain` has a state here, or after `READY_MS`. */
  async whenPresent(domain: GlobalDomain): Promise<void> {
    await this.starting.catch(() => undefined);
    // Without canonical state (the backend has none) nothing will arrive: don't wait.
    if (this.data[domain] !== undefined || this.disposed || !this.available) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve();
      }, READY_MS);
      const off = this.listen(domain, () => {
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }

  /** Waits until this window has applied the backend's current revision (or reads a snapshot after a short wait). */
  async catchUp(): Promise<void> {
    if (this.gaveUp) {
      // Asked for the current state after giving up: one more snapshot (a fresh episode of retries).
      this.resyncsInARow = 0;
      await this.resync();
      return;
    }
    if (!this.available) return;
    const target = await this.ipc.revision().catch(() => this.revision);
    if (this.revision >= target) return;
    const reached = new Promise<boolean>((resolve) => {
      this.waiters.push({
        revision: target,
        resolve: () => {
          resolve(true);
        },
      });
      setTimeout(() => {
        resolve(false);
      }, CATCH_UP_MS);
    });
    if (!(await reached)) await this.resync();
  }

  /** Stops listening and lets go of every listener and waiter (window closing). */
  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
    this.listeners.clear();
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
    this.held = [];
  }

  private receive(delta: StateDelta): void {
    if (this.disposed) return;
    // Not following any more: the next snapshot (a catch-up or refresh) covers it; holding it would only grow.
    if (this.gaveUp) return;
    if (this.resyncing !== null || !this.available) {
      this.held.push(delta);
      return;
    }
    if (delta.revision <= this.revision) return;
    if (delta.revision !== this.revision + 1) {
      this.log(
        `state: revision ${String(delta.revision)} arrived after ${String(this.revision)}; reading a snapshot`,
      );
      this.held.push(delta);
      void this.resync();
      return;
    }
    this.applyDelta(delta);
    this.resyncsInARow = 0;
  }

  /** Reads a full snapshot (start-up, a gap, another folder) and then the deltas held back meanwhile. One at a time. */
  private resync(): Promise<void> {
    if (this.resyncing !== null) return this.resyncing.then(() => this.resync());
    if (this.resyncsInARow >= MAX_RESYNCS) {
      if (this.available && !this.gaveUp) {
        const reason =
          "Revisions keep going missing; this window stopped following the application state.";
        this.log(`state: ${reason}`);
        this.failed(reason);
      }
      this.gaveUp = this.gaveUp || this.available;
      this.available = false;
      this.held = [];
      return Promise.resolve();
    }
    this.resyncsInARow += 1;
    // The deltas that arrived before the snapshot is asked for: the snapshot is at least as new as each of them.
    const heldBefore = this.held.length;
    // Marked as in progress before the read starts: a delta that arrives while it is asked for is held, not chased.
    let done: () => void = () => undefined;
    const resyncing = new Promise<void>((resolve) => (done = resolve));
    this.resyncing = resyncing;
    void this.readSnapshot()
      .catch(() => false)
      .then((read) => {
        this.resyncing = null;
        try {
          if (read) this.dropImpossible(heldBefore);
          this.drainHeld();
        } finally {
          done();
        }
      });
    return resyncing;
  }

  /**
   * The backend publishes a delta only after its state reached that revision, so a snapshot asked for later is never
   * older than it. A delta held from before the read that claims a newer revision didn't come from the backend's
   * order (it would hold the window in a gap forever): it is dropped, the snapshot already has the current state.
   */
  private dropImpossible(heldBefore: number): void {
    const before = this.held.slice(0, heldBefore);
    const impossible = before.filter((delta) => delta.revision > this.revision);
    if (impossible.length === 0) return;
    this.log(
      `state: dropped ${String(impossible.length)} delta(s) newer than the snapshot taken after them (revision ${String(this.revision)})`,
    );
    this.held = this.held.filter((delta) => !impossible.includes(delta));
  }

  /** Whether a snapshot was read and applied (or found older than what is applied). */
  private async readSnapshot(): Promise<boolean> {
    let snapshot: StateSnapshot | null;
    try {
      snapshot = await this.ipc.snapshot();
    } catch (error) {
      this.log(`state: the snapshot couldn't be read: ${String(error)}`);
      return false;
    }
    // `null`: the backend has no canonical state; anything that isn't a snapshot is treated the same way.
    if (snapshot === null || typeof snapshot !== "object" || this.disposed) return false;
    this.available = true;
    // A snapshot older than what is applied can't happen in order, but never step back.
    if (snapshot.revision < this.revision) return true;
    this.revision = snapshot.revision;
    this.setWorkspace(snapshot.workspace ?? null);
    const present = new Set(snapshot.domains.map((entry) => entry.domain));
    for (const entry of snapshot.domains) this.setDomain(entry.domain, entry.data);
    // The folder's domains the snapshot doesn't have aren't known (any more): never keep a stale value.
    for (const domain of WORKSPACE_DOMAINS) {
      if (!present.has(domain) && this.data[domain] !== undefined)
        this.setDomain(domain, undefined);
    }
    this.wake();
    return true;
  }

  /** Another folder (or none): the old folder's state is dropped at once. */
  private setWorkspace(key: string | null): void {
    if (key === this.workspace) return;
    this.workspace = key;
    for (const domain of WORKSPACE_DOMAINS) {
      if (this.data[domain] !== undefined) this.setDomain(domain, undefined);
    }
  }

  private drainHeld(): void {
    if (!this.available) {
      this.held = [];
      return;
    }
    const held = this.held.sort((a, b) => a.revision - b.revision);
    this.held = [];
    for (const delta of held) {
      if (delta.revision <= this.revision) continue;
      if (delta.revision !== this.revision + 1) {
        // Still a gap after the snapshot: read again (bounded by MAX_RESYNCS).
        this.held = held.filter((later) => later.revision >= delta.revision);
        void this.resync();
        return;
      }
      this.applyDelta(delta);
    }
    this.resyncsInARow = 0;
    this.gaveUp = false;
  }

  private applyDelta(delta: StateDelta): void {
    this.revision = delta.revision;
    const scoped = isWorkspaceDomain(delta.domain);
    const mine = !scoped || (delta.scope !== undefined && delta.scope === this.workspace);
    if (mine && delta.tick !== true) {
      this.setDomain(
        delta.domain,
        delta.removed === true || delta.data === null ? undefined : delta.data,
      );
    }
    this.wake();
  }

  private setDomain(domain: Domain, data: DomainData[Domain] | undefined): void {
    if (data === undefined) {
      // Only a folder's state can go away; a global domain keeps its last value.
      if (!isWorkspaceDomain(domain)) return;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (this.data as Record<string, unknown>)[domain];
    } else {
      (this.data as Record<Domain, DomainData[Domain]>)[domain] = data;
    }
    for (const listener of [...(this.listeners.get(domain) ?? [])]) {
      try {
        (listener as (value: DomainData[Domain] | undefined) => void)(data);
      } catch (error) {
        this.log(`state: a ${domain} listener failed: ${String(error)}`);
      }
    }
  }

  private wake(): void {
    const ready = this.waiters.filter((waiter) => waiter.revision <= this.revision);
    this.waiters = this.waiters.filter((waiter) => waiter.revision > this.revision);
    for (const waiter of ready) waiter.resolve();
  }
}
