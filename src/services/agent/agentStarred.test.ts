import { describe, expect, it, vi } from "vitest";

import type { HistorySummary } from "./agentHistory";
import { parseStarred, splitHistory, StarredChats, STARRED_KEY } from "./agentStarred";

const item = (id: string, updatedAt: number): HistorySummary => ({
  id,
  title: id,
  providerId: "openmind-agent",
  updatedAt,
  messageCount: 2,
});

function store(saved: string | null = null) {
  const values = new Map<string, string>();
  if (saved !== null) values.set(STARRED_KEY, saved);
  const write = vi.fn((key: string, value: string) => {
    values.set(key, value);
    return Promise.resolve();
  });
  const starred = new StarredChats((key) => Promise.resolve(values.get(key) ?? null), write);
  return { starred, write, values };
}

describe("starred chats", () => {
  it("reads only valid, unique ids", () => {
    expect(parseStarred('["a","b","a",3,"",null]')).toEqual(["a", "b"]);
    expect(parseStarred("not json")).toEqual([]);
    expect(parseStarred('{"a":1}')).toEqual([]);
    expect(parseStarred(null)).toEqual([]);
  });

  it("puts starred conversations first, both groups newest first", () => {
    const split = splitHistory([item("old", 1), item("star-old", 2), item("new", 5), item("star-new", 4)], [
      "star-old",
      "star-new",
      "deleted",
    ]);
    expect(split.starred.map((i) => i.id)).toEqual(["star-new", "star-old"]);
    expect(split.recent.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("loads the saved stars once and keeps a star given before the read finished", async () => {
    const { starred } = store('["a"]');
    starred.toggle("b");
    await starred.load();
    await starred.load();
    expect([...starred.list()].sort()).toEqual(["a", "b"]);
  });

  it("stars, unstars and removes, saving each change and telling listeners", async () => {
    const { starred, values } = store();
    await starred.load();
    const listener = vi.fn();
    starred.subscribe(listener);
    expect(starred.toggle("c1")).toBe(true);
    expect(starred.has("c1")).toBe(true);
    await vi.waitFor(() => {
      expect(values.get(STARRED_KEY)).toBe('["c1"]');
    });
    expect(starred.toggle("c1")).toBe(false);
    await vi.waitFor(() => {
      expect(values.get(STARRED_KEY)).toBe("[]");
    });
    starred.toggle("c2");
    starred.remove("c2");
    starred.remove("never");
    expect(starred.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("keeps working when the settings store fails", async () => {
    const starred = new StarredChats(
      () => Promise.reject(new Error("db")),
      () => Promise.reject(new Error("db")),
    );
    await starred.load();
    expect(starred.toggle("x")).toBe(true);
    expect(starred.has("x")).toBe(true);
  });
});
