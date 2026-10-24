import { MAX_LAYOUT_LENGTH, parseSavedBuffer, type SavedBuffer } from "./documentSession";
import type { EditorGroup, EditorGroupService, EditorKind } from "./editorGroupService";
import type { IpcClient } from "./ipc";

const LAYOUT_KEY = "editor.layout";
const LAYOUT_VERSION = 3;

/** One saved tab. File paths or recovery resource URIs identify the document. */
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
  buffers?: SavedBuffer[];
}

/**
 * Persists the editor arrangement — how many groups, what each holds, which
 * tab and group are active, which groups are locked, group widths — as one
 * JSON value in `editor_settings`, and hands it back on the next launch. It
 * records layout and bounded recovery snapshots; recreating the documents is
 * `WorkspaceService`'s job (it owns the documents). Saves are coalesced, so a
 * burst of changes writes once.
 */
export class EditorLayoutService {
  private paused = false;
  private documentTimer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private disposed = false;
  private unreadable = false;
  private scheduled = false;
  private unsubscribe: (() => void) | null = null;
  /** A failed save was reported already (one message per session, not one per keystroke). */
  private reportedFailure = false;

  constructor(
    private readonly ipc: IpcClient,
    private readonly groups: EditorGroupService,
    /** Resolves a document to a native file path or a saved buffer URI. */
    private readonly pathOf: (docId: string) => string | null,
    /** Told when the layout can't be saved (a full disk, a locked database): the tabs wouldn't come back after a restart. */
    private readonly onSaveFailed: (error: unknown) => void = () => undefined,
    private readonly buffers: () => SavedBuffer[] = () => [],
  ) {}

  /** Starts saving after every change to the groups. Safe to call more than once. */
  startAutoSave(): void {
    this.unsubscribe ??= this.groups.subscribe(() => {
      this.scheduleSave();
    });
  }

  dispose(): void {
    if (this.documentTimer !== null) { clearTimeout(this.documentTimer); this.documentTimer = null; void this.save(); }
    this.disposed = true;
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
    const buffers = this.buffers();
    if (buffers.length > 256 || buffers.some(buffer => !parseSavedBuffer(buffer))) throw new Error("Some editor buffers exceed recovery limits.");
    return {
      groups: state.groups.map((group) => serializeGroup(group, this.pathOf)),
      activeGroup: Math.max(
        0,
        state.groups.findIndex((group) => group.id === state.activeGroupId),
      ),
      weights: state.weights,
      ...(buffers.length ? { buffers } : {}),
    };
  }

  /** Back up text after a short quiet period rather than serializing it on every keystroke. */
  scheduleDocumentSave(): void {
    if (this.disposed || this.paused) return;
    if (this.documentTimer !== null) clearTimeout(this.documentTimer);
    this.documentTimer = setTimeout(() => { this.documentTimer = null; void this.save(); }, 300);
  }

  async save(): Promise<boolean> {
    if (this.paused || this.disposed || this.unreadable) return false;
    if (this.documentTimer !== null) { clearTimeout(this.documentTimer); this.documentTimer = null; }
    try {
      const payload = JSON.stringify({ version: LAYOUT_VERSION, ...this.serialize() });
      if (payload.length > MAX_LAYOUT_LENGTH || new TextEncoder().encode(payload).length > MAX_LAYOUT_LENGTH) throw new Error("Editor recovery data exceeds 64 MB.");
      // Serialize database writes so an older, slower request cannot overwrite a newer snapshot.
      const write = this.writes.catch(() => undefined).then(() => this.ipc.settingsSet(LAYOUT_KEY, payload));
      this.writes = write;
      await write;
      this.reportedFailure = false;
      return true;
    } catch (error) {
      if (this.reportedFailure) return false;
      this.reportedFailure = true;
      this.onSaveFailed(error);
      return false;
    }
  }

  /** The saved layout, or `null` if there is none (first run, or unreadable). */
  async load(): Promise<SavedLayout | null> {
    try {
      const raw = await this.ipc.settingsGet(LAYOUT_KEY);
      const saved = raw === null ? null : parseLayout(raw);
      this.unreadable = raw !== null && saved === null;
      if (this.unreadable) this.onSaveFailed(new Error("Existing editor recovery data could not be read; it has been preserved."));
      return saved;
    } catch (error) {
      this.unreadable = true;
      this.onSaveFailed(error);
      return null;
    }
  }

  private scheduleSave(): void {
    if (this.scheduled || this.disposed) return;
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
  if (raw.length > MAX_LAYOUT_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if ((record.version !== 1 && record.version !== 2 && record.version !== LAYOUT_VERSION) || !Array.isArray(record.groups)) return null;

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
  const buffers = new Map<string, SavedBuffer>();
  if ((record.version === 2 || record.version === LAYOUT_VERSION) && Array.isArray(record.buffers)) {
    for (const candidate of (record.buffers as unknown[]).slice(0, 256)) {
      const buffer = parseSavedBuffer(candidate);
      if (buffer && !buffers.has(buffer.uri)) buffers.set(buffer.uri, buffer);
    }
  }
  return { groups, activeGroup, weights, ...(buffers.size ? { buffers: [...buffers.values()] } : {}) };
}

function parseTab(candidate: unknown): SavedTab[] {
  if (typeof candidate !== "object" || candidate === null) return [];
  const tab = candidate as Record<string, unknown>;
  if (typeof tab.path !== "string" || tab.path === "" || !isKind(tab.kind)) return [];
  return [{ path: tab.path, kind: tab.kind, preview: tab.preview === true }];
}
