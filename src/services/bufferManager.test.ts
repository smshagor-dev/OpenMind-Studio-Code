import { afterEach, describe, expect, it, vi } from "vitest";

import { BufferManager } from "./bufferManager";

describe("BufferManager", () => {
  let manager: BufferManager;

  afterEach(() => {
    manager.disposeAll();
  });

  it("creates a model with the given initial content", () => {
    manager = new BufferManager();

    manager.create("a", "hello");

    expect(manager.getValue("a")).toBe("hello");
  });

  it("throws when creating a buffer id that already exists", () => {
    manager = new BufferManager();
    manager.create("a", "hello");

    expect(() => manager.create("a", "again")).toThrow(/already exists/);
  });

  it("setValue updates the model's content", () => {
    manager = new BufferManager();
    manager.create("a", "hello");

    manager.setValue("a", "world");

    expect(manager.getValue("a")).toBe("world");
  });

  it("onDidChangeContent fires when the model's content changes", () => {
    manager = new BufferManager();
    manager.create("a", "hello");
    const listener = vi.fn();
    manager.onDidChangeContent("a", listener);

    manager.setValue("a", "world");

    expect(listener).toHaveBeenCalled();
  });

  it("returned unsubscribe function stops further notifications", () => {
    manager = new BufferManager();
    manager.create("a", "hello");
    const listener = vi.fn();
    const unsubscribe = manager.onDidChangeContent("a", listener);
    unsubscribe();

    manager.setValue("a", "world");

    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose removes the buffer so further access throws", () => {
    manager = new BufferManager();
    manager.create("a", "hello");

    manager.dispose("a");

    expect(() => manager.getValue("a")).toThrow(/does not exist/);
  });

  it("get returns undefined for a buffer that was never created", () => {
    manager = new BufferManager();

    expect(manager.get("missing")).toBeUndefined();
  });

  it("disposeAll clears every buffer", () => {
    manager = new BufferManager();
    manager.create("a", "1");
    manager.create("b", "2");

    manager.disposeAll();

    expect(manager.get("a")).toBeUndefined();
    expect(manager.get("b")).toBeUndefined();
  });
});
