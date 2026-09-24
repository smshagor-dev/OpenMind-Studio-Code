import type { EditorGroupView, EditorTabView, WorkspaceService } from "./workspaceService";

export interface OpenEditorEntry {
  groupId: string;
  /** 1-based position of the group in the row, for labels like "Group 2". */
  groupNumber: number;
  tab: EditorTabView;
  active: boolean;
}

/**
 * The list of everything open across all editor groups, and the bulk close
 * actions on it (Close All, Close Saved). "Saved" means the document has no
 * unsaved changes; untitled buffers with content are unsaved and stay.
 */
export class OpenEditorsService {
  constructor(private readonly workspace: WorkspaceService) {}

  groups(): EditorGroupView[] {
    return this.workspace.getState().groups;
  }

  /** Every open tab, group by group. */
  list(groupId?: string): OpenEditorEntry[] {
    return this.groups().flatMap((group, index) =>
      groupId !== undefined && group.id !== groupId
        ? []
        : group.tabs.map((tab) => ({
            groupId: group.id,
            groupNumber: index + 1,
            tab,
            active: group.activeTabId === tab.id,
          })),
    );
  }

  count(groupId?: string): number {
    return this.list(groupId).length;
  }

  hasSaved(groupId?: string): boolean {
    return this.list(groupId).some((entry) => !entry.tab.dirty);
  }

  async closeAll(groupId?: string): Promise<void> {
    await this.workspace.closeAll(groupId ?? null);
  }

  async closeSaved(groupId?: string): Promise<void> {
    await this.workspace.closeTabsWhere(groupId ?? null, (tab) => !tab.dirty);
  }

  /** Focuses an entry's tab (and its group). */
  show(entry: OpenEditorEntry): void {
    this.workspace.activateTab(entry.groupId, entry.tab.id);
  }
}
