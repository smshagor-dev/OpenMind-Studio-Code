import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditorGroupService, tabIdFor } from "./editorGroupService";

describe("EditorGroupService", () => {
  let groups: EditorGroupService;

  beforeEach(() => {
    groups = new EditorGroupService();
  });

  const ids = (groupId: string) => groups.getGroup(groupId)?.tabs.map((tab) => tab.id) ?? [];

  it("starts with one empty active group", () => {
    const state = groups.getState();

    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]).toMatchObject({ tabs: [], activeTabId: null, locked: false });
    expect(state.activeGroupId).toBe("group-1");
    expect(state.weights).toEqual([1]);
  });

  it("opens tabs, activates the newest, and reopening an open document just focuses it", () => {
    groups.openTab("doc-1", "text");
    groups.openTab("doc-2", "text");
    groups.openTab("doc-1", "text");

    expect(ids("group-1")).toEqual(["doc-1", "doc-2"]);
    expect(groups.activeTab()?.id).toBe("doc-1");
  });

  it("a text tab and a preview tab of the same document are separate tabs", () => {
    groups.openTab("doc-1", "text");
    groups.openTab("doc-1", "markdownPreview");

    expect(ids("group-1")).toEqual(["doc-1", "doc-1#preview"]);
    expect(tabIdFor("doc-1", "markdownPreview")).toBe("doc-1#preview");
  });

  it("closing the active tab activates its neighbour, and the last close leaves an empty group", () => {
    groups.openTab("a", "text");
    groups.openTab("b", "text");
    groups.openTab("c", "text");
    groups.activateTab("group-1", "b");

    groups.closeTab("group-1", "b");
    expect(groups.activeTab()?.id).toBe("c");
    groups.closeTab("group-1", "c");
    expect(groups.activeTab()?.id).toBe("a");
    groups.closeTab("group-1", "a");

    expect(groups.getState().groups).toHaveLength(1);
    expect(groups.activeTab()).toBeNull();
    expect(groups.closeTab("group-1", "missing")).toBeNull();
  });

  describe("preview tabs", () => {
    it("a preview tab is replaced by the next preview, but never replaces a kept tab", () => {
      groups.openTab("kept", "text");
      groups.openTab("p1", "text", { preview: true });
      groups.openTab("p2", "text", { preview: true });

      expect(ids("group-1")).toEqual(["kept", "p2"]);
      expect(groups.getGroup("group-1")?.tabs[1]?.preview).toBe(true);
    });

    it("opening a provisional tab for real (or pinning it) keeps it", () => {
      groups.openTab("p1", "text", { preview: true });
      groups.openTab("p1", "text");
      groups.openTab("p2", "text", { preview: true });
      groups.pinTab("group-1", "p2");
      groups.openTab("p3", "text", { preview: true });

      expect(ids("group-1")).toEqual(["p1", "p2", "p3"]);
      expect(groups.getGroup("group-1")?.tabs.map((tab) => tab.preview)).toEqual([
        false,
        false,
        true,
      ]);
    });

    it("pinDoc pins every provisional tab of an edited document, in every group", () => {
      groups.openTab("d", "text", { preview: true });
      const second = groups.splitRight({ copyActiveTab: false });
      groups.openTab("d", "text", { groupId: second, preview: true });

      groups.pinDoc("d");

      expect(groups.allTabs().every(({ tab }) => !tab.preview)).toBe(true);
    });

    it("opening an already-open kept tab as a preview leaves it kept", () => {
      groups.openTab("a", "text");
      groups.openTab("a", "text", { preview: true });

      expect(groups.getGroup("group-1")?.tabs[0]?.preview).toBe(false);
    });
  });

  describe("splitting", () => {
    it("Split Right adds a group to the right showing the active tab, and focuses it", () => {
      groups.openTab("a", "text");
      groups.openTab("b", "text");

      const right = groups.splitRight();

      expect(groups.getState().groups.map((g) => g.id)).toEqual(["group-1", right]);
      expect(ids(right)).toEqual(["b"]);
      expect(groups.getState().activeGroupId).toBe(right);
      expect(groups.getState().weights).toEqual([0.5, 0.5]);
      expect(groups.groupToTheRight("group-1")?.id).toBe(right);
      expect(groups.groupToTheRight(right)).toBeNull();
    });

    it("splitting can leave the new group empty", () => {
      groups.openTab("a", "text");

      const right = groups.splitRight({ copyActiveTab: false });

      expect(ids(right)).toEqual([]);
    });

    it("splitting an empty group makes an empty group", () => {
      const right = groups.splitRight();

      expect(ids(right)).toEqual([]);
      expect(groups.getState().groups).toHaveLength(2);
    });

    it("closing the last tab of a non-only group removes the group and refocuses a neighbour", () => {
      groups.openTab("a", "text");
      const right = groups.splitRight();

      groups.closeTab(right, "a");

      expect(groups.getState().groups.map((g) => g.id)).toEqual(["group-1"]);
      expect(groups.getState().activeGroupId).toBe("group-1");
      expect(groups.getState().weights).toEqual([1]);
    });

    it("closeGroup returns the group's tabs; the only group is emptied instead of removed", () => {
      groups.openTab("a", "text");
      const right = groups.splitRight();

      expect(groups.closeGroup(right).map((tab) => tab.id)).toEqual(["a"]);
      expect(groups.closeGroup("group-1").map((tab) => tab.id)).toEqual(["a"]);
      expect(groups.getState().groups).toHaveLength(1);
      expect(ids("group-1")).toEqual([]);
    });

    it("group ids are never reused after a group closes", () => {
      const second = groups.splitRight();
      groups.closeGroup(second);

      expect(groups.splitRight()).not.toBe(second);
    });
  });

  describe("locking", () => {
    it("files open in the active group unless it is locked, then in another unlocked group", () => {
      groups.openTab("a", "text");
      const right = groups.splitRight();
      groups.setActiveGroup("group-1");
      groups.setLocked("group-1", true);

      expect(groups.targetGroupId()).toBe(right);
      groups.openTab("b", "text");

      expect(ids("group-1")).toEqual(["a"]);
      expect(ids(right)).toEqual(["a", "b"]);
    });

    it("if every group is locked a new group is created for the file", () => {
      groups.openTab("a", "text");
      groups.setLocked("group-1", true);

      groups.openTab("b", "text");

      expect(groups.getState().groups).toHaveLength(2);
      expect(ids("group-1")).toEqual(["a"]);
      expect(groups.getState().groups[1]?.tabs.map((tab) => tab.id)).toEqual(["b"]);
    });

    it("an explicit group is honoured even when locked, and unlocking restores normal targeting", () => {
      groups.setLocked("group-1", true);
      groups.openTab("x", "text", { groupId: "group-1" });
      groups.setLocked("group-1", false);

      expect(groups.targetGroupId()).toBe("group-1");
      expect(ids("group-1")).toEqual(["x"]);
    });
  });

  it("replaceTab swaps the view in place and activates it", () => {
    groups.openTab("a", "text");
    groups.openTab("b", "text");
    groups.openTab("c", "text");

    groups.replaceTab("group-1", "b", "b", "markdownPreview");

    expect(ids("group-1")).toEqual(["a", "b#preview", "c"]);
    expect(groups.activeTab()?.id).toBe("b#preview");
  });

  it("replaceTab onto a view that is already open does not duplicate it", () => {
    groups.openTab("a", "text");
    groups.openTab("a", "markdownPreview");

    groups.replaceTab("group-1", "a", "a", "markdownPreview");

    expect(ids("group-1")).toEqual(["a#preview"]);
  });

  it("tabsForDoc finds a document's tabs across groups", () => {
    groups.openTab("a", "text");
    groups.splitRight();

    expect(groups.tabsForDoc("a").map(({ group }) => group.id)).toEqual(["group-1", "group-2"]);
    expect(groups.tabsForDoc("nope")).toEqual([]);
  });

  it("weights are normalised, floored and ignored when the count is wrong", () => {
    groups.splitRight();

    groups.setWeights([3, 1]);
    expect(groups.getState().weights).toEqual([0.75, 0.25]);
    groups.setWeights([1, 0]);
    expect(groups.getState().weights[1]).toBeGreaterThan(0);
    const before = groups.getState().weights;
    groups.setWeights([1, 1, 1]);
    expect(groups.getState().weights).toBe(before);
  });

  it("restore replaces the layout and falls back to one empty group when given nothing", () => {
    groups.restore(
      [
        {
          id: "x",
          tabs: [{ id: "a", docId: "a", kind: "text", preview: false }],
          activeTabId: "a",
          locked: true,
        },
        { id: "y", tabs: [], activeTabId: null, locked: false },
      ],
      1,
      [2, 1],
    );

    const state = groups.getState();
    expect(state.groups.map((g) => g.id)).toEqual(["group-1", "group-2"]);
    expect(state.activeGroupId).toBe("group-2");
    expect(state.groups[0]?.locked).toBe(true);
    expect(state.weights[0]).toBeCloseTo(2 / 3);

    groups.restore([], 0);
    expect(groups.getState().groups).toHaveLength(1);
  });

  it("notifies subscribers on every change and replaces the state object", () => {
    const listener = vi.fn();
    groups.subscribe(listener);
    const before = groups.getState();

    groups.openTab("a", "text");

    expect(listener).toHaveBeenCalled();
    expect(groups.getState()).not.toBe(before);
  });
});
