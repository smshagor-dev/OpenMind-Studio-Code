import { describe, expect, it } from "vitest";

import { ExplorerFollowService } from "./explorerFollow";

function harness(root: string | null = "C:/proj") {
  const state = { active: null as string | null, root };
  const activeListeners = new Set<() => void>();
  const explorerListeners = new Set<() => void>();
  const revealed: string[] = [];
  let release: (() => void) | null = null;
  let slow = false;
  const follow = new ExplorerFollowService({
    activePath: () => state.active,
    onActiveChanged: (l) => {
      activeListeners.add(l);
      return () => activeListeners.delete(l);
    },
    rootPath: () => state.root,
    onExplorerChanged: (l) => {
      explorerListeners.add(l);
      return () => explorerListeners.delete(l);
    },
    reveal: (path) => {
      revealed.push(path);
      explorerListeners.forEach((l) => {
        l();
      }); // the explorer emits for its own reveal
      return slow ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    },
  });
  const stop = follow.start();
  return {
    revealed,
    stop,
    activate(path: string | null) {
      state.active = path;
      activeListeners.forEach((l) => {
        l();
      });
    },
    openFolder(path: string | null) {
      state.root = path;
      explorerListeners.forEach((l) => {
        l();
      });
    },
    makeSlow() {
      slow = true;
    },
    finish() {
      release?.();
      release = null;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Explorer follows the active editor", () => {
  it("reveals each newly active file once, ignoring the explorer's own change events", async () => {
    const h = harness();
    h.activate("C:/proj/src/deep/a.ts");
    h.activate("C:/proj/src/deep/a.ts"); // the same tab again (other tab state changed)
    h.activate("C:\\PROJ\\src\\deep\\A.ts"); // the same file in another spelling
    await tick();
    expect(h.revealed).toEqual(["C:/proj/src/deep/a.ts"]);
    h.activate("C:/proj/b.ts");
    await tick();
    expect(h.revealed).toEqual(["C:/proj/src/deep/a.ts", "C:/proj/b.ts"]);
  });

  it("comes back to a file after another one was active", async () => {
    const h = harness();
    h.activate("C:/proj/a.ts");
    await tick();
    h.activate("C:/proj/b.ts");
    await tick();
    h.activate("C:/proj/a.ts");
    await tick();
    expect(h.revealed).toEqual(["C:/proj/a.ts", "C:/proj/b.ts", "C:/proj/a.ts"]);
  });

  it("reveals the active file when the folder opens after the tabs were restored", async () => {
    const h = harness(null);
    h.activate("C:/proj/src/a.ts");
    await tick();
    expect(h.revealed).toEqual([]);
    h.openFolder("C:/proj");
    await tick();
    expect(h.revealed).toEqual(["C:/proj/src/a.ts"]);
  });

  it("does nothing for a tab without a file and after it is stopped", async () => {
    const h = harness();
    h.activate(null);
    await tick();
    h.stop();
    h.activate("C:/proj/a.ts");
    await tick();
    expect(h.revealed).toEqual([]);
  });

  it("runs one reveal at a time and ends on the newest file after quick tab switches", async () => {
    const h = harness();
    h.makeSlow();
    h.activate("C:/proj/1.ts");
    await tick();
    h.activate("C:/proj/2.ts");
    h.activate("C:/proj/3.ts");
    await tick();
    expect(h.revealed).toEqual(["C:/proj/1.ts"]); // still loading the first one's folders
    h.finish();
    await tick();
    expect(h.revealed).toEqual(["C:/proj/1.ts", "C:/proj/3.ts"]); // 2 was skipped, 3 is last
  });
});
