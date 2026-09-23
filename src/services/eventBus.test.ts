import { describe, expect, it, vi } from "vitest";

import { EventBus } from "./eventBus";

interface TestEvents extends Record<string, unknown> {
  ping: { count: number };
  greet: string;
}

describe("EventBus", () => {
  it("calls subscribed listeners with the emitted payload", () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.on("ping", handler);

    bus.emit("ping", { count: 1 });

    expect(handler).toHaveBeenCalledWith({ count: 1 });
  });

  it("stops calling a listener after the returned unsubscribe function runs", () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    const unsubscribe = bus.on("ping", handler);
    unsubscribe();

    bus.emit("ping", { count: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it("stops calling a listener after off()", () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.on("greet", handler);
    bus.off("greet", handler);

    bus.emit("greet", "hi");

    expect(handler).not.toHaveBeenCalled();
  });

  it("supports multiple independent listeners for the same event", () => {
    const bus = new EventBus<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("greet", a);
    bus.on("greet", b);

    bus.emit("greet", "hi");

    expect(a).toHaveBeenCalledWith("hi");
    expect(b).toHaveBeenCalledWith("hi");
  });

  it("does nothing when emitting an event with no listeners", () => {
    const bus = new EventBus<TestEvents>();

    expect(() => {
      bus.emit("ping", { count: 1 });
    }).not.toThrow();
  });

  it("clear() removes every listener", () => {
    const bus = new EventBus<TestEvents>();
    const handler = vi.fn();
    bus.on("greet", handler);

    bus.clear();
    bus.emit("greet", "hi");

    expect(handler).not.toHaveBeenCalled();
  });
});
