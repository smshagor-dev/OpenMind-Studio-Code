import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "./commandRegistry";

describe("CommandRegistry", () => {
  it("executes the registered handler with the given arguments", async () => {
    const registry = new CommandRegistry();
    const handler = vi.fn();
    registry.register("file.save", handler);

    await registry.execute("file.save", "a.rs", 42);

    expect(handler).toHaveBeenCalledWith("a.rs", 42);
  });

  it("awaits an async handler before resolving", async () => {
    const registry = new CommandRegistry();
    let resolved = false;
    registry.register("slow", async () => {
      await Promise.resolve();
      resolved = true;
    });

    await registry.execute("slow");

    expect(resolved).toBe(true);
  });

  it("throws when executing an unregistered command", async () => {
    const registry = new CommandRegistry();

    await expect(registry.execute("missing")).rejects.toThrow(/not registered/);
  });

  it("throws when registering the same command id twice", () => {
    const registry = new CommandRegistry();
    registry.register("dup", () => {});

    expect(() => {
      registry.register("dup", () => {});
    }).toThrow(/already registered/);
  });

  it("has() and list() reflect registered commands", () => {
    const registry = new CommandRegistry();
    registry.register("a", () => {});
    registry.register("b", () => {});

    expect(registry.has("a")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.list().sort()).toEqual(["a", "b"]);
  });

  it("unregister() removes a command", async () => {
    const registry = new CommandRegistry();
    registry.register("a", () => {});

    registry.unregister("a");

    expect(registry.has("a")).toBe(false);
    await expect(registry.execute("a")).rejects.toThrow();
  });

  it("reports unregistered commands as disabled", () => {
    const registry = new CommandRegistry();

    expect(registry.isEnabled("terminal.new")).toBe(false);
  });

  it("evaluates the enabled predicate, defaulting to enabled", () => {
    const registry = new CommandRegistry();
    let ready = false;
    registry.register("always", vi.fn());
    registry.register("gated", vi.fn(), { enabled: () => ready });

    expect(registry.isEnabled("always")).toBe(true);
    expect(registry.isEnabled("gated")).toBe(false);
    ready = true;
    expect(registry.isEnabled("gated")).toBe(true);
  });

  it("reports checked state only for toggle commands", () => {
    const registry = new CommandRegistry();
    registry.register("plain", vi.fn());
    registry.register("toggle", vi.fn(), { checked: () => true });

    expect(registry.isChecked("plain")).toBeUndefined();
    expect(registry.isChecked("toggle")).toBe(true);
  });

  it("notifies onDidExecute listeners even when the handler throws", async () => {
    const registry = new CommandRegistry();
    const listener = vi.fn();
    registry.onDidExecute(listener);
    registry.register("boom", () => {
      throw new Error("boom");
    });

    await expect(registry.execute("boom")).rejects.toThrow("boom");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
