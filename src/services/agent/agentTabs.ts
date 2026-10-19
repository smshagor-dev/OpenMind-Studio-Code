/**
 * Conversation tabs. A tab is a saved conversation; switching to one resumes it the way /resume does (the backend keeps one
 * conversation per window, so the session is replaced), and that is refused while a turn runs rather than stopping the
 * work. The list (ids and titles) is kept per window; an empty "new chat" is a tab only while it is the current one.
 */
import type { Entry } from "./agentModel";

export interface AgentTab {
  id: string;
  title: string;
}

export const MAX_TABS = 8;
const TITLE_LENGTH = 40;

export function parseTabs(raw: string | null): AgentTab[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const tabs: AgentTab[] = [];
    for (const item of value as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const { id, title } = item as Record<string, unknown>;
      if (typeof id !== "string" || !id || id.length > 100 || typeof title !== "string") continue;
      if (!tabs.some((tab) => tab.id === id)) tabs.push({ id, title: title.slice(0, TITLE_LENGTH) });
    }
    return tabs.slice(-MAX_TABS);
  } catch {
    return [];
  }
}

/** The first user message, shortened: what the tab is called. Empty for a conversation with no message yet. */
export function conversationTitle(entries: readonly Entry[]): string {
  const first = entries.find((entry): entry is Extract<Entry, { kind: "user" }> => entry.kind === "user");
  if (!first) return "";
  const line = first.text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

/** `tabs` with the current conversation in it (added or renamed) and empty tabs other than the current one left out. */
export function withCurrent(tabs: readonly AgentTab[], id: string, title: string): AgentTab[] {
  const at = tabs.findIndex((tab) => tab.id === id);
  const next = at < 0 ? [...tabs, { id, title }] : tabs.map((tab, i) => (i === at ? { id, title: title || tab.title } : tab));
  const kept = next.filter((tab) => tab.title || tab.id === id);
  while (kept.length > MAX_TABS) kept.splice(kept.findIndex((tab) => tab.id !== id), 1);
  return kept;
}

/** The tab to show after closing `id`: the one to its right, else to its left. */
export function neighbour(tabs: readonly AgentTab[], id: string): string | null {
  const at = tabs.findIndex((tab) => tab.id === id);
  if (at < 0) return null;
  return tabs[at + 1]?.id ?? tabs[at - 1]?.id ?? null;
}

interface TabsHost {
  current: () => { id: string | undefined; entries: readonly Entry[]; busy: boolean; tabs: readonly AgentTab[] };
  /** Puts the list into the state (no history write, no notification of its own). */
  setTabs: (tabs: AgentTab[]) => void;
  save: (raw: string) => Promise<void>;
  /** Resumes a saved conversation; "missing" when it no longer exists (other failures are reported by the host). */
  restore: (id: string) => Promise<boolean | "missing">;
  newChat: () => Promise<boolean>;
  notify: (key: string) => void;
}

export class AgentTabs {
  private closing: string | null = null;
  private saved = "";

  constructor(private readonly host: TabsHost) {}

  load(raw: string | null): void {
    const tabs = parseTabs(raw);
    this.saved = JSON.stringify(tabs);
    this.host.setTabs(tabs);
  }

  /** Follows the current conversation (call after its id or transcript changed). */
  sync(): void {
    const { id, entries, tabs } = this.host.current();
    if (!id || id === this.closing) return;
    const next = withCurrent(tabs, id, conversationTitle(entries));
    if (JSON.stringify(next) !== JSON.stringify(tabs)) this.host.setTabs(next);
    const persisted = JSON.stringify(next.filter((tab) => tab.title));
    if (persisted !== this.saved) {
      this.saved = persisted;
      void this.host.save(persisted).catch(() => undefined);
    }
  }

  /** Why the tabs can't change now, or null. */
  blocked(): string | null {
    return this.host.current().busy ? "agent.tabs.busy" : null;
  }

  async switchTo(id: string): Promise<void> {
    if (id === this.host.current().id) return;
    const reason = this.blocked();
    if (reason) {
      this.host.notify(reason);
      return;
    }
    if ((await this.host.restore(id)) !== "missing") return;
    this.host.setTabs(this.host.current().tabs.filter((tab) => tab.id !== id));
    this.sync();
    this.host.notify("agent.tabs.missing");
  }

  async open(): Promise<void> {
    const reason = this.blocked();
    if (reason) {
      this.host.notify(reason);
      return;
    }
    await this.host.newChat();
  }

  async close(id: string): Promise<void> {
    const { id: current, tabs } = this.host.current();
    if (id !== current) {
      this.host.setTabs(tabs.filter((tab) => tab.id !== id));
      this.sync();
      return;
    }
    const reason = this.blocked();
    if (reason) {
      this.host.notify(reason);
      return;
    }
    const next = neighbour(tabs, id);
    this.closing = id;
    try {
      this.host.setTabs(tabs.filter((tab) => tab.id !== id));
      if (!next || (await this.host.restore(next)) !== true) await this.host.newChat();
    } finally {
      this.closing = null;
      this.sync();
    }
  }
}
