export interface ShutdownRequest { requestId: string; token: string }

interface ShutdownDeps {
  currentToken(): string | null;
  flush(): Promise<boolean>;
  acknowledge(request: ShutdownRequest, saved: boolean): Promise<void>;
  freezeInput(): () => void;
  onError(error: unknown): void;
}

/** One native shutdown attempt; cancellation and page replacement invalidate late replies. */
export class ShutdownRecovery {
  private active: { request: ShutdownRequest; release(): void } | null = null;
  private disposed = false;

  constructor(private readonly deps: ShutdownDeps) {}

  async request(value: unknown): Promise<void> {
    if (this.disposed || !value || typeof value !== "object") return;
    const r = value as Record<string, unknown>;
    if (typeof r.requestId !== "string" || !r.requestId || r.requestId.length > 128
      || typeof r.token !== "string" || r.token !== this.deps.currentToken()) return;
    if (this.active?.request.requestId === r.requestId && this.active.request.token === r.token) return;
    this.release();
    const round = { request: { requestId: r.requestId, token: r.token }, release: this.deps.freezeInput() };
    this.active = round;
    let saved = false;
    try { saved = await this.deps.flush(); }
    catch (error) { if (this.active === round) this.deps.onError(error); }
    if (this.active !== round || round.request.token !== this.deps.currentToken()) return;
    try { await this.deps.acknowledge(round.request, saved); }
    catch (error) { if (this.active === round) this.deps.onError(error); }
  }

  finish(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const r = value as Record<string, unknown>;
    if (!this.active || this.active.request.requestId !== r.requestId) return;
    this.release();
    if (typeof r.error === "string" && r.error) this.deps.onError(new Error(r.error));
  }

  dispose(): void { this.disposed = true; this.release(); }

  private release(): void {
    const round = this.active;
    this.active = null;
    round?.release();
  }
}

const inputBarriers = new WeakMap<HTMLElement, { users: number; inert: boolean; busy: string | null }>();

/** Preserve pre-existing state even when overlapping listeners retire out of order. */
export function freezeWorkbenchInput(): () => void {
  const root = document.documentElement;
  let barrier = inputBarriers.get(root);
  if (!barrier) {
    barrier = { users: 0, inert: root.inert, busy: root.getAttribute("aria-busy") };
    inputBarriers.set(root, barrier);
  }
  const current = barrier;
  current.users++;
  root.inert = true;
  root.setAttribute("aria-busy", "true");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--current.users > 0) return;
    inputBarriers.delete(root);
    root.inert = current.inert;
    if (current.busy === null) root.removeAttribute("aria-busy");
    else root.setAttribute("aria-busy", current.busy);
  };
}
