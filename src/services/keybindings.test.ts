import { describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "./commandRegistry";
import { KeybindingService, normalizeKeyEvent, type KeyEventLike } from "./keybindings";

function key(code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods };
}

describe("normalizeKeyEvent", () => {
  it("formats modifiers in a stable Ctrl+Shift+Alt order", () => {
    expect(normalizeKeyEvent(key("KeyS", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+S");
    expect(normalizeKeyEvent(key("KeyZ", { altKey: true }))).toBe("Alt+Z");
  });

  it("uses the physical key so Shift doesn't change the symbol", () => {
    expect(normalizeKeyEvent(key("Equal", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+=");
    expect(normalizeKeyEvent(key("Backquote", { ctrlKey: true }))).toBe("Ctrl+`");
  });

  it("maps arrows, digits and function keys", () => {
    expect(normalizeKeyEvent(key("ArrowUp", { altKey: true }))).toBe("Alt+Up");
    expect(normalizeKeyEvent(key("Digit5", { ctrlKey: true, shiftKey: true }))).toBe(
      "Ctrl+Shift+5",
    );
    expect(normalizeKeyEvent(key("F11"))).toBe("F11");
  });

  it("returns null for a bare modifier press", () => {
    expect(normalizeKeyEvent(key("ControlLeft", { ctrlKey: true }))).toBeNull();
  });
});

describe("KeybindingService", () => {
  it("resolves app-owned bindings for enabled commands", () => {
    const commands = new CommandRegistry();
    commands.register("file.save", vi.fn());
    const service = new KeybindingService(commands);

    expect(service.resolve(key("KeyS", { ctrlKey: true }))).toBe("file.save");
  });

  it("ignores bindings whose command is not registered", () => {
    const service = new KeybindingService(new CommandRegistry());

    expect(service.resolve(key("KeyS", { ctrlKey: true }))).toBeNull();
  });

  it("never dispatches editor-owned bindings (Monaco handles those itself)", () => {
    const commands = new CommandRegistry();
    commands.register("edit.undo", vi.fn());
    const service = new KeybindingService(commands);

    expect(service.resolve(key("KeyZ", { ctrlKey: true }))).toBeNull();
    expect(service.labelFor("edit.undo")).toBe("Ctrl+Z");
  });

  it("falls through to the next binding for the same key when the first is disabled", () => {
    const commands = new CommandRegistry();
    commands.register("debug.stepInto", vi.fn(), { enabled: () => false });
    commands.register("view.toggleFullScreen", vi.fn());
    const service = new KeybindingService(commands);

    expect(service.resolve(key("F11"))).toBe("view.toggleFullScreen");
  });
});
