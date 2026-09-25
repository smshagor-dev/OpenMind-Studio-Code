import type { EditorGroup, EditorGroupService, EditorKind } from "./editorGroupService";
import type { IpcClient } from "./ipc";

const LAYOUT_KEY = "editor.layout";
const LAYOUT_VERSION = 1;

/** One saved tab. Only file-backed editors are saved — an untitled buffer has nothing to reopen. */
export interface SavedTab {
  path: string;
  kind: EditorKind;
  preview: boolean;
}

export interface SavedGroup {
  tabs: SavedTab[];
  /** Index into `tabs` of the active tab. */
  activeIndex: number;
  locked: boolean;
}

export interface SavedLayout {
  groups: SavedGroup[];
  activeGroup: number;
  weights: number[];
}

/**
 * Persists the editor arrangement — how many groups, what each holds, which
 * tab and group are active, which groups are locked, group widths — as one
 * JSON value in `editor_settings`, and hands it back on the next launch. It
 * only records and parses the layout; opening the files again is
 * `WorkspaceService`'s job (it owns the documents). Saves are coalesced, so a
 * burst of changes writes once.
 */
export class EditorLayoutService {
  private paused = false;
  private scheduled = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly ipc: IpcClient,
    private readonly groups: EditorGroupService,
    /** Resolves a document id to its file path (`null` for untitled buffers). */
    private readonly pathOf: (docId: string) => string | null,
  ) {}

  /** Starts saving after every change to the groups. Safe to call more than once. */
  startAutoSave(): void {
    this.unsubscribe ??= this.groups.subscribe(() => {
      this.scheduleSave();
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** While restoring, the half-built layout must not overwrite the saved one. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  serialize(): SavedLayout {
    const state = this.groups.getState();
    return {
      groups: state.groups.map((group) => serializeGroup(group, this.pathOf)),
      activeGroup: Math.max(
        0,
        state.groups.findIndex((group) => group.id === state.activeGroupId),
      ),
      weights: state.weights,
    };
  }

  async save(): Promise<void> {
    if (this.paused) return;
    const payload = JSON.stringify({ version: LAYOUT_VERSION, ...this.serialize() });
    await this.ipc.settingsSet(LAYOUT_KEY, payload).catch(() => undefined);
  }

  /** The saved layout, or `null` if there is none (first run, or unreadable). */
  async load(): Promise<SavedLayout | null> {
    const raw = await this.ipc.settingsGet(LAYOUT_KEY).catch(() => null);
    return raw === null ? null : parseLayout(raw);
  }

  private scheduleSave(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.save();
    });
  }
}

function serializeGroup(group: EditorGroup, pathOf: (docId: string) => string | null): SavedGroup {
  const tabs: SavedTab[] = [];
  let activeIndex = 0;
  for (const tab of group.tabs) {
    const path = pathOf(tab.docId);
    if (path === null) continue;
    if (tab.id === group.activeTabId) activeIndex = tabs.length;
    tabs.push({ path, kind: tab.kind, preview: tab.preview });
  }
  return { tabs, activeIndex, locked: group.locked };
}

function isKind(value: unknown): value is EditorKind {
  return value === "text" || value === "markdownPreview" || value === "filePreview";
}

/** Validates untrusted stored JSON; anything malformed is dropped rather than trusted. */
export function parseLayout(raw: string): SavedLayout | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== LAYOUT_VERSION || !Array.isArray(record.groups)) return null;

  const groups: SavedGroup[] = [];
  for (const candidate of record.groups as unknown[]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const group = candidate as Record<string, unknown>;
    const tabs = Array.isArray(group.tabs) ? (group.tabs as unknown[]).flatMap(parseTab) : [];
    const activeIndex =
      typeof group.activeIndex === "number" && group.activeIndex >= 0 ? group.activeIndex : 0;
    groups.push({
      tabs,
      activeIndex: Math.min(activeIndex, Math.max(0, tabs.length - 1)),
      locked: group.locked === true,
    });
  }
  if (groups.length === 0) return null;
  const weights =
    Array.isArray(record.weights) &&
    record.weights.length === groups.length &&
    record.weights.every((weight) => typeof weight === "number" && weight > 0)
      ? (record.weights as number[])
      : groups.map(() => 1 / groups.length);
  const activeGroup =
    typeof record.activeGroup === "number" && record.activeGroup < groups.length
      ? Math.max(0, record.activeGroup)
      : 0;
  return { groups, activeGroup, weights };
}

function parseTab(candidate: unknown): SavedTab[] {
  if (typeof candidate !== "object" || candidate === null) return [];
  const tab = candidate as Record<string, unknown>;
  if (typeof tab.path !== "string" || tab.path === "" || !isKind(tab.kind)) return [];
  return [{ path: tab.path, kind: tab.kind, preview: tab.preview === true }];
}
