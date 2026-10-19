import { describe, expect, it, vi } from "vitest";
import type { Entry } from "./agentModel";
import { AgentTabs, conversationTitle, MAX_TABS, neighbour, parseTabs, withCurrent, type AgentTab } from "./agentTabs";

const user = (text: string): Entry => ({ kind: "user", id: "u1", text });

describe("tab rules", () => {
  it("reads only valid, unique tabs", () => {
    expect(parseTabs('[{"id":"a","title":"A"},{"id":"a","title":"again"},{"id":3},"x",{"id":"b","title":"B"}]')).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
    expect(parseTabs("not json")).toEqual([]);
    expect(parseTabs(null)).toEqual([]);
  });

  it("names a conversation after its first message", () => {
    expect(conversationTitle([])).toBe("");
    expect(conversationTitle([user("  Fix   the login\nbug ")])).toBe("Fix the login bug");
    expect(conversationTitle([user("x".repeat(80))])).toHaveLength(40);
  });

  it("adds, renames and drops empty tabs that aren't current", () => {
    const tabs: AgentTab[] = [{ id: "a", title: "A" }, { id: "new", title: "" }];
    expect(withCurrent(tabs, "b", "")).toEqual([{ id: "a", title: "A" }, { id: "b", title: "" }]);
    expect(withCurrent(tabs, "new", "Hello")).toEqual([{ id: "a", title: "A" }, { id: "new", title: "Hello" }]);
    const many = Array.from({ length: MAX_TABS }, (_, i) => ({ id: `t${i}`, title: `T${i}` }));
    const next = withCurrent(many, "z", "Z");
    expect(next).toHaveLength(MAX_TABS);
    expect(next.at(-1)).toEqual({ id: "z", title: "Z" });
    expect(next[0]?.id).toBe("t1");
  });

  it("picks the right neighbour, else the left", () => {
    const tabs = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }];
    expect(neighbour(tabs, "b")).toBe("c");
    expect(neighbour(tabs, "c")).toBe("b");
    expect(neighbour([{ id: "a", title: "A" }], "a")).toBeNull();
  });
});

function controller(start: { id: string; tabs: AgentTab[]; busy?: boolean; entries?: Entry[] }) {
  const state = { id: start.id, tabs: start.tabs, busy: start.busy ?? false, entries: start.entries ?? [] };
  const saved: string[] = [];
  const notices: string[] = [];
  const known = new Set(start.tabs.map((tab) => tab.id));
  const tabs = new AgentTabs({
    current: () => state,
    setTabs: (next) => {
      state.tabs = next;
    },
    save: (raw) => {
      saved.push(raw);
      return Promise.resolve();
    },
    restore: vi.fn((id: string) => {
      if (!known.has(id)) return Promise.resolve("missing" as const);
      state.id = id;
      state.entries = [user(start.tabs.find((tab) => tab.id === id)?.title ?? "")];
      tabs.sync();
      return Promise.resolve(true);
    }),
    newChat: vi.fn(() => {
      state.id = "fresh";
      state.entries = [];
      tabs.sync();
      return Promise.resolve(true);
    }),
    notify: (key) => {
      notices.push(key);
    },
  });
  return { tabs, state, saved, notices };
}

describe("AgentTabs", () => {
  it("keeps the current conversation in the list and saves titled tabs only", () => {
    const { tabs, state, saved } = controller({ id: "a", tabs: [], entries: [user("First")] });
    tabs.sync();
    expect(state.tabs).toEqual([{ id: "a", title: "First" }]);
    expect(saved.at(-1)).toBe('[{"id":"a","title":"First"}]');
    state.id = "b";
    state.entries = [];
    tabs.sync();
    expect(state.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(saved).toHaveLength(1);
  });

  it("switches by resuming, and refuses while a turn runs", async () => {
    const tabs: AgentTab[] = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
    const busy = controller({ id: "a", tabs, busy: true });
    await busy.tabs.switchTo("b");
    expect(busy.state.id).toBe("a");
    expect(busy.notices).toEqual(["agent.tabs.busy"]);
    const idle = controller({ id: "a", tabs });
    await idle.tabs.switchTo("b");
    expect(idle.state.id).toBe("b");
  });

  it("closes a missing conversation's tab with a notice", async () => {
    const { tabs, state, notices } = controller({ id: "a", tabs: [{ id: "a", title: "A" }] });
    state.tabs = [...state.tabs, { id: "gone", title: "Gone" }];
    await tabs.switchTo("gone");
    expect(state.tabs.map((tab) => tab.id)).toEqual(["a"]);
    expect(notices).toEqual(["agent.tabs.missing"]);
  });

  it("closing the current tab moves to its neighbour, the last one to a new chat", async () => {
    const two = controller({ id: "a", tabs: [{ id: "a", title: "A" }, { id: "b", title: "B" }] });
    await two.tabs.close("a");
    expect(two.state.id).toBe("b");
    expect(two.state.tabs.map((tab) => tab.id)).toEqual(["b"]);
    const one = controller({ id: "a", tabs: [{ id: "a", title: "A" }] });
    await one.tabs.close("a");
    expect(one.state.id).toBe("fresh");
    expect(one.state.tabs.map((tab) => tab.id)).toEqual(["fresh"]);
  });

  it("closing another tab leaves the current conversation alone", async () => {
    const { tabs, state } = controller({ id: "a", tabs: [{ id: "a", title: "A" }, { id: "b", title: "B" }], entries: [user("A")] });
    await tabs.close("b");
    expect(state.id).toBe("a");
    expect(state.tabs).toEqual([{ id: "a", title: "A" }]);
  });
});
