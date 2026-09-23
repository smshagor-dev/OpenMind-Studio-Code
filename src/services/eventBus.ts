type Listener<T> = (payload: T) => void;

/**
 * Generic, typed publish/subscribe bus. Not app-specific — the app composes
 * its own event map (see `services/events.ts`) and passes it as `TEvents`.
 */
export class EventBus<TEvents extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof TEvents, Set<Listener<unknown>>>();

  /** Subscribe to `event`. Returns an unsubscribe function. */
  on<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<unknown>);
    return () => {
      this.off(event, listener);
    };
  }

  off<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<unknown>);
  }

  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      listener(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
