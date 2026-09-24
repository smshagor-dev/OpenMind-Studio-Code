import type { EventBus } from "./eventBus";
import type { AppEvents } from "./events";
import type { IpcClient } from "./ipc";
import { safely } from "./safely";

export interface PortEntry {
  id: string;
  port: number;
  label: string;
  /** Where the service can be reached in a browser, if it speaks http(s); `null` otherwise. */
  url: string | null;
  /** Who registered it (a service name), so it can be unregistered together with that service. */
  source: string;
}

export interface PortRegistration {
  port: number;
  label: string;
  url?: string | null;
  source: string;
}

/**
 * The registry of local ports that OpenMind Studio's own services are
 * listening on or forwarding (a dev server started by a future PHP/Node
 * runner, for instance). It is deliberately a *registry*: services tell it
 * what they started. It does not scan the operating system for open ports —
 * that would be guessing, and nothing here pretends otherwise.
 */
export class PortsService {
  private ports: readonly PortEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly ipc: IpcClient,
    private readonly events: EventBus<AppEvents>,
  ) {}

  list(): readonly PortEntry[] {
    return this.ports;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Registers a port; registering the same source+port again updates it. Returns the entry's id. */
  register(registration: PortRegistration): string {
    if (
      !Number.isInteger(registration.port) ||
      registration.port < 1 ||
      registration.port > 65535
    ) {
      throw new RangeError(`"${String(registration.port)}" is not a valid port number`);
    }
    const id = `${registration.source}:${String(registration.port)}`;
    const entry: PortEntry = {
      id,
      port: registration.port,
      label: registration.label,
      url: registration.url ?? null,
      source: registration.source,
    };
    this.ports = [...this.ports.filter((existing) => existing.id !== id), entry].sort(
      (a, b) => a.port - b.port,
    );
    this.notify();
    return id;
  }

  unregister(id: string): boolean {
    const before = this.ports.length;
    this.ports = this.ports.filter((entry) => entry.id !== id);
    const removed = this.ports.length !== before;
    if (removed) this.notify();
    return removed;
  }

  /** Drops everything a service registered — used when that service stops. */
  unregisterSource(source: string): void {
    const remaining = this.ports.filter((entry) => entry.source !== source);
    if (remaining.length !== this.ports.length) {
      this.ports = remaining;
      this.notify();
    }
  }

  /** Whether "open in browser" can work for this entry. */
  canOpenInBrowser(id: string): boolean {
    return this.ports.some((entry) => entry.id === id && entry.url !== null);
  }

  /** Opens the entry's URL in the default browser. Resolves `false` if it has none. */
  async openInBrowser(id: string): Promise<boolean> {
    const entry = this.ports.find((candidate) => candidate.id === id);
    if (entry?.url == null) {
      return false;
    }
    const url = entry.url;
    return safely(
      this.events,
      async () => {
        await this.ipc.openExternalUrl(url);
        return true;
      },
      `open ${url}`,
      false,
    );
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
