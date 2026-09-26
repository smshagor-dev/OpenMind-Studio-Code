import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoSaveService } from "./autoSaveService";
import { EventBus } from "./eventBus";
import type { AppEvents } from "./events";

function rig(mode = "afterDelay") {
  const events = new EventBus<AppEvents>();
  const values: Record<string, string | number> = {
    "files.autoSave": mode,
    "files.autoSaveDelay": 500,
  };
  const dirty = new Set(["a"]);
  const backed = ["a", "b"];
  let external: "none" | "changed" | "deleted" = "none";
  let active: string | null = "a";
  const activeHandlers: (() => void)[] = [];
  const blurHandlers: (() => void)[] = [];
  const changeHandlers: (() => void)[] = [];
  const save = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockImplementation((_scope: string, id: string, value: string) => {
    values[id] = value;
    changeHandlers.forEach((h) => {
      h();
    });
    return Promise.resolve();
  });
  const service = new AutoSaveService({
    events,
    settings: {
      string: (id, fallback) => String(values[id] ?? fallback),
      number: (id, fallback) => Number(values[id] ?? fallback),
      set,
      onChange: (_ids, handler) => {
        changeHandlers.push(handler);
        return () => undefined;
      },
    },
    documents: {
      fileBackedIds: () => backed,
      isDirty: (id) => dirty.has(id),
      externalState: () => external,
    },
    save,
    activeDocId: () => active,
    onActiveChanged: (h) => {
      activeHandlers.push(h);
      return () => undefined;
    },
    onWindowBlur: (h) => {
      blurHandlers.push(h);
      return () => undefined;
    },
  });
  service.start();
  return {
    service,
    events,
    save,
    set,
    dirty,
    values,
    setExternal: (state: typeof external) => {
      external = state;
    },
    switchTo: (id: string) => {
      active = id;
      activeHandlers.forEach((h) => {
        h();
      });
    },
    blur: () => {
      blurHandlers.forEach((h) => {
        h();
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Auto Save", () => {
  it("after delay: saves a changed file once the delay has passed, without Format on Save", async () => {
    const r = rig();
    r.events.emit("documentDirtyChanged", { id: "a", dirty: true });
    await vi.advanceTimersByTimeAsync(499);
    expect(r.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(r.save).toHaveBeenCalledWith("a", false);
  });

  it("each new edit restarts the delay, and a file that became clean is not saved", async () => {
    const r = rig();
    r.events.emit("documentDirtyChanged", { id: "a", dirty: true });
    await vi.advanceTimersByTimeAsync(400);
    r.events.emit("documentDirtyChanged", { id: "a", dirty: true });
    await vi.advanceTimersByTimeAsync(400);
    expect(r.save).not.toHaveBeenCalled();
    r.dirty.delete("a");
    r.events.emit("documentDirtyChanged", { id: "a", dirty: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.save).not.toHaveBeenCalled();
  });

  it("does nothing while off, for an untitled file, and for a file changed on disk underneath", async () => {
    const off = rig("off");
    off.events.emit("documentDirtyChanged", { id: "a", dirty: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(off.save).not.toHaveBeenCalled();

    const r = rig();
    r.dirty.add("untitled");
    r.events.emit("documentDirtyChanged", { id: "untitled", dirty: true });
    r.setExternal("changed");
    r.events.emit("documentDirtyChanged", { id: "a", dirty: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.save).not.toHaveBeenCalled();
  });

  it("on focus change: saves the file you leave (with Format on Save) and everything when the window loses focus", async () => {
    const r = rig("onFocusChange");
    r.switchTo("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.save).toHaveBeenCalledWith("a", true);
    r.save.mockClear();
    r.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.save).toHaveBeenCalledWith("a", true);
  });

  it("on window change: leaving the window saves, switching editors does not", async () => {
    const r = rig("onWindowChange");
    r.switchTo("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(r.save).not.toHaveBeenCalled();
    r.blur();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.save).toHaveBeenCalledWith("a", true);
  });

  it("the File menu toggle turns it on after a delay, and off again", async () => {
    const r = rig("off");
    expect(r.service.enabled()).toBe(false);
    await r.service.toggle();
    expect(r.set).toHaveBeenLastCalledWith("user", "files.autoSave", "afterDelay");
    expect(r.service.enabled()).toBe(true);
    await r.service.toggle();
    expect(r.set).toHaveBeenLastCalledWith("user", "files.autoSave", "off");
  });

  it("turning it on saves what is already changed after the delay", async () => {
    const r = rig("off");
    await r.service.toggle();
    await vi.advanceTimersByTimeAsync(600);
    expect(r.save).toHaveBeenCalledWith("a", false);
  });

  it("a save that fails is not thrown at the editor", async () => {
    const r = rig();
    r.save.mockRejectedValue(new Error("disk full"));
    r.events.emit("documentDirtyChanged", { id: "a", dirty: true });
    await vi.advanceTimersByTimeAsync(600);
    expect(r.save).toHaveBeenCalledTimes(1);
  });
});
