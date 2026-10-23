/**
 * How a document is shown in a tab: the text editor, or the rendered
 * Markdown preview. The same document can be open in several tabs at once
 * (in different groups, or as text and preview side by side). `filePreview` is a
 * read-only preview of a file that is not a text document (image, PDF, Office file,
 * or a text format shown rendered); its `docId` belongs to `FilePreviewService`.
 */
export type EditorKind = "text" | "markdownPreview" | "filePreview";

export interface EditorTab {
  /** Unique within a group. A text tab's id is its document id; a preview tab's is `<docId>#preview`. */
  id: string;
  docId: string;
  kind: EditorKind;
  /** A provisional ("italic") tab: replaced by the next file opened as a preview, kept once edited or double-clicked. */
  preview: boolean;
}

export interface EditorGroup {
  id: string;
  tabs: EditorTab[];
  activeTabId: string | null;
  /** A locked group only shows what was put in it deliberately: new files open in another group instead. */
  locked: boolean;
}

export interface EditorGroupsState {
  groups: EditorGroup[];
  activeGroupId: string;
  /** Relative widths of the groups, side by side; always one per group. */
  weights: number[];
}

export interface OpenTabOptions {
  /** Which group to open in; defaults to the active group (or, if that is locked, another one). */
  groupId?: string;
  preview?: boolean;
  /** Make the tab (and its group) active. Default true. */
  activate?: boolean;
  /** Select the tab without moving focus from the current group. */
  preserveFocus?: boolean;
}

export function tabIdFor(docId: string, kind: EditorKind): string {
  return kind === "markdownPreview" ? `${docId}#preview` : docId;
}

const MIN_WEIGHT = 0.1;

/**
 * The editor area's model: an ordered row of groups, each with its own tabs
 * and active tab, plus which group has focus. Pure data — it knows nothing
 * about documents, files or Monaco (a tab only carries a document id), so the
 * document lifecycle stays in `WorkspaceService`. Every change replaces the
 * state object, so it works directly with `useSyncExternalStore`.
 */
export class EditorGroupService {
  private state: EditorGroupsState;
  private nextGroup = 2;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.state = {
      groups: [{ id: "group-1", tabs: [], activeTabId: null, locked: false }],
      activeGroupId: "group-1",
      weights: [1],
    };
  }

  getState(): EditorGroupsState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getGroup(groupId: string): EditorGroup | undefined {
    return this.state.groups.find((group) => group.id === groupId);
  }

  activeGroup(): EditorGroup {
    return this.getGroup(this.state.activeGroupId) ?? this.requireFirst();
  }

  activeTab(): EditorTab | null {
    const group = this.activeGroup();
    return group.tabs.find((tab) => tab.id === group.activeTabId) ?? null;
  }

  /** Every tab, with the group it is in. */
  allTabs(): { group: EditorGroup; tab: EditorTab }[] {
    return this.state.groups.flatMap((group) => group.tabs.map((tab) => ({ group, tab })));
  }

  tabsForDoc(docId: string): { group: EditorGroup; tab: EditorTab }[] {
    return this.allTabs().filter(({ tab }) => tab.docId === docId);
  }

  /** The group a new file should open in: the active one unless it is locked. */
  targetGroupId(): string {
    const active = this.activeGroup();
    if (!active.locked) {
      return active.id;
    }
    const unlocked = this.state.groups.find((group) => !group.locked);
    if (unlocked) {
      return unlocked.id;
    }
    // Every group is locked: a new group is the only place a new file can go.
    return this.splitRight({ fromGroupId: active.id, copyActiveTab: false });
  }

  setActiveGroup(groupId: string): void {
    if (this.getGroup(groupId) && this.state.activeGroupId !== groupId) {
      this.set({ ...this.state, activeGroupId: groupId });
    }
  }

  /** Opens (or focuses) a tab for `docId` in a group. */
  openTab(docId: string, kind: EditorKind, options: OpenTabOptions = {}): EditorTab {
    const groupId = options.groupId ?? this.targetGroupId();
    const group = this.getGroup(groupId) ?? this.activeGroup();
    const id = tabIdFor(docId, kind);
    const activate = options.activate ?? true;
    const existing = group.tabs.find((tab) => tab.id === id);

    let tabs: EditorTab[];
    let tab: EditorTab;
    if (existing) {
      // Opening it again for real keeps a provisional tab; it never turns a kept tab provisional.
      tab = !options.preview && existing.preview ? { ...existing, preview: false } : existing;
      tabs = group.tabs.map((candidate) => (candidate.id === id ? tab : candidate));
    } else {
      tab = { id, docId, kind, preview: options.preview === true };
      const replaceable = tab.preview
        ? group.tabs.find((candidate) => candidate.preview)
        : undefined;
      tabs = replaceable
        ? group.tabs.map((candidate) => (candidate.id === replaceable.id ? tab : candidate))
        : [...group.tabs, tab];
    }
    this.replaceGroup(
      { ...group, tabs, activeTabId: activate ? tab.id : group.activeTabId },
      activate && !options.preserveFocus ? group.id : undefined,
    );
    return tab;
  }

  /** Activates a tab and focuses its group. */
  activateTab(groupId: string, tabId: string): void {
    const group = this.getGroup(groupId);
    if (!group?.tabs.some((tab) => tab.id === tabId)) {
      return;
    }
    if (group.activeTabId === tabId && this.state.activeGroupId === groupId) {
      return;
    }
    this.replaceGroup({ ...group, activeTabId: tabId }, groupId);
  }

  /**
   * Removes a tab. The neighbouring tab becomes active; a group left empty
   * disappears unless it is the only one. Returns what was removed.
   */
  closeTab(groupId: string, tabId: string): EditorTab | null {
    const group = this.getGroup(groupId);
    const index = group?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
    if (!group || index === -1) {
      return null;
    }
    const closed = group.tabs[index] ?? null;
    const tabs = group.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId =
      group.activeTabId === tabId
        ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null)
        : group.activeTabId;
    if (tabs.length === 0 && this.state.groups.length > 1) {
      this.removeGroup(groupId);
    } else {
      this.replaceGroup({ ...group, tabs, activeTabId });
    }
    return closed;
  }

  /** Makes a provisional tab permanent. */
  pinTab(groupId: string, tabId: string): void {
    const group = this.getGroup(groupId);
    if (!group?.tabs.some((tab) => tab.id === tabId && tab.preview)) {
      return;
    }
    this.replaceGroup({
      ...group,
      tabs: group.tabs.map((tab) => (tab.id === tabId ? { ...tab, preview: false } : tab)),
    });
  }

  /** Makes every provisional tab of a document permanent (it was edited). */
  pinDoc(docId: string): void {
    if (!this.allTabs().some(({ tab }) => tab.docId === docId && tab.preview)) {
      return;
    }
    this.set({
      ...this.state,
      groups: this.state.groups.map((group) => ({
        ...group,
        tabs: group.tabs.map((tab) => (tab.docId === docId ? { ...tab, preview: false } : tab)),
      })),
    });
  }

  /** Swaps a tab for another view in the same position and activates it (Reopen Editor With). */
  replaceTab(groupId: string, tabId: string, docId: string, kind: EditorKind): EditorTab | null {
    const group = this.getGroup(groupId);
    const index = group?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
    if (!group || index === -1) {
      return null;
    }
    const id = tabIdFor(docId, kind);
    const replacement: EditorTab = { id, docId, kind, preview: false };
    const others = group.tabs.filter((tab) => tab.id !== tabId && tab.id !== id);
    const position = Math.min(index, others.length);
    const tabs = [...others.slice(0, position), replacement, ...others.slice(position)];
    this.replaceGroup({ ...group, tabs, activeTabId: id }, groupId);
    return replacement;
  }

  /**
   * Adds a new group to the right of `fromGroupId` (default: the active one)
   * and focuses it. By default the source group's active tab is shown in it
   * too, like VS Code's "Split Editor Right". Returns the new group's id.
   */
  splitRight(options: { fromGroupId?: string; copyActiveTab?: boolean; preserveFocus?: boolean } = {}): string {
    const fromId = options.fromGroupId ?? this.state.activeGroupId;
    const from = this.getGroup(fromId) ?? this.activeGroup();
    const source = from.tabs.find((tab) => tab.id === from.activeTabId);
    const copy = options.copyActiveTab ?? true;
    const id = `group-${String(this.nextGroup++)}`;
    const tabs: EditorTab[] = copy && source ? [{ ...source, preview: false }] : [];
    const created: EditorGroup = {
      id,
      tabs,
      activeTabId: tabs[0]?.id ?? null,
      locked: false,
    };
    const index = this.state.groups.findIndex((group) => group.id === from.id);
    const groups = [...this.state.groups];
    groups.splice(index + 1, 0, created);
    this.set({ groups, activeGroupId: options.preserveFocus ? this.state.activeGroupId : id, weights: equalWeights(groups.length) });
    return id;
  }

  /**
   * Makes the editor area exactly `count` groups side by side (1 to 4): missing ones are added empty on the right, and
   * the tabs of extra ones move into the last kept group (a tab already there is not duplicated), so nothing is closed.
   */
  setColumns(count: number): void {
    const wanted = Math.max(1, Math.min(4, Math.trunc(count)));
    let groups = [...this.state.groups];
    if (groups.length > wanted) {
      const kept = groups.slice(0, wanted);
      const last = kept[wanted - 1];
      if (last === undefined) return;
      const tabs = [...last.tabs];
      for (const extra of groups.slice(wanted)) {
        for (const tab of extra.tabs) {
          if (!tabs.some((existing) => existing.id === tab.id))
            tabs.push({ ...tab, preview: false });
        }
      }
      kept[wanted - 1] = { ...last, tabs, activeTabId: last.activeTabId ?? tabs[0]?.id ?? null };
      groups = kept;
    }
    while (groups.length < wanted) {
      groups.push({
        id: `group-${String(this.nextGroup++)}`,
        tabs: [],
        activeTabId: null,
        locked: false,
      });
    }
    const active = groups.some((group) => group.id === this.state.activeGroupId)
      ? this.state.activeGroupId
      : (groups[groups.length - 1]?.id ?? this.state.activeGroupId);
    this.set({ groups, activeGroupId: active, weights: equalWeights(groups.length) });
  }

  /** The group immediately to the right of `groupId`, if there is one. */
  groupToTheRight(groupId: string): EditorGroup | null {
    const index = this.state.groups.findIndex((group) => group.id === groupId);
    return index === -1 ? null : (this.state.groups[index + 1] ?? null);
  }

  /** Removes a whole group; the last group is emptied rather than removed. Returns the tabs it held. */
  closeGroup(groupId: string): EditorTab[] {
    const group = this.getGroup(groupId);
    if (!group) {
      return [];
    }
    if (this.state.groups.length === 1) {
      this.replaceGroup({ ...group, tabs: [], activeTabId: null });
    } else {
      this.removeGroup(groupId);
    }
    return group.tabs;
  }

  setLocked(groupId: string, locked: boolean): void {
    const group = this.getGroup(groupId);
    if (group && group.locked !== locked) {
      this.replaceGroup({ ...group, locked });
    }
  }

  /** Live resize of the row: weights are normalised and never let a group vanish. */
  setWeights(weights: number[]): void {
    if (weights.length !== this.state.groups.length) {
      return;
    }
    const clean = weights.map((weight) => Math.max(MIN_WEIGHT, weight));
    const total = clean.reduce((sum, weight) => sum + weight, 0);
    this.set({ ...this.state, weights: clean.map((weight) => weight / total) });
  }

  /** Replaces the whole layout (session restore). Invalid or empty input falls back to one empty group. */
  restore(groups: EditorGroup[], activeIndex: number, weights?: number[]): void {
    if (groups.length === 0) {
      this.set({
        groups: [{ id: "group-1", tabs: [], activeTabId: null, locked: false }],
        activeGroupId: "group-1",
        weights: [1],
      });
      this.nextGroup = 2;
      return;
    }
    const renamed = groups.map((group, index) => ({ ...group, id: `group-${String(index + 1)}` }));
    this.nextGroup = renamed.length + 1;
    const usable = weights?.length === renamed.length && weights.every((w) => w > 0);
    const total = usable ? weights.reduce((sum, weight) => sum + weight, 0) : 0;
    this.set({
      groups: renamed,
      activeGroupId: (renamed[activeIndex] ?? renamed[0])?.id ?? "group-1",
      weights: usable ? weights.map((weight) => weight / total) : equalWeights(renamed.length),
    });
  }

  private requireFirst(): EditorGroup {
    const first = this.state.groups[0];
    if (!first) {
      throw new Error("the editor area always has at least one group");
    }
    return first;
  }

  private replaceGroup(group: EditorGroup, activateGroupId?: string): void {
    this.set({
      ...this.state,
      groups: this.state.groups.map((candidate) => (candidate.id === group.id ? group : candidate)),
      activeGroupId: activateGroupId ?? this.state.activeGroupId,
    });
  }

  private removeGroup(groupId: string): void {
    const index = this.state.groups.findIndex((group) => group.id === groupId);
    const groups = this.state.groups.filter((group) => group.id !== groupId);
    const activeGroupId =
      this.state.activeGroupId === groupId
        ? (groups[index]?.id ?? groups[index - 1]?.id ?? this.state.activeGroupId)
        : this.state.activeGroupId;
    this.set({ groups, activeGroupId, weights: equalWeights(groups.length) });
  }

  private set(state: EditorGroupsState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function equalWeights(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}
