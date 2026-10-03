import { afterEach, describe, expect, it, vi } from "vitest";

import type { CanonicalIpc, StateDelta, StateSnapshot } from "./canonicalIpc";
import { CanonicalStateService } from "./canonicalStateService";

function packages(revision: number, generation: number): StateDelta {
  return { revision, domain: "packages", data: { generation } };
}

function snapshotAt(revision: number, generation: number): StateSnapshot {
  return { revision, domains: [{ domain: "packages", data: { generation } }] };
}

function rig() {
  let deliver: (delta: StateDelta) => void = () => undefined;
  const unlisten = vi.fn();
  let backendRevision = 0;
  let folder: string | null = null;
  const snapshots: (() => Promise<StateSnapshot | null>)[] = [];
  const ipc = {
    onDelta: vi.fn((handler: (delta: StateDelta) => void) => {
      deliver = handler;
      return Promise.resolve(unlisten);
    }),
    snapshot: vi.fn(() =>
      (snapshots.shift() ?? (() => Promise.resolve(snapshotAt(backendRevision, 0))))(),
    ),
    revision: vi.fn(() => Promise.resolve(backendRevision)),
    attach: vi.fn(() => Promise.resolve(folder)),
    refresh: vi.fn(() => Promise.resolve()),
  } satisfies CanonicalIpc;
  const failed = vi.fn();
  const service = new CanonicalStateService(ipc, () => undefined, failed);
  return {
    ipc,
    service,
    failed,
    unlisten,
    deliver: (delta: StateDelta) => {
      deliver(delta);
    },
    nextSnapshot: (answer: () => Promise<StateSnapshot | null>) => snapshots.push(answer),
    setBackendRevision: (revision: number) => {
      backendRevision = revision;
    },
    openFolder: (key: string | null) => {
      folder = key;
    },
  };
}

describe("CanonicalStateService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("listens before it asks for the snapshot, and applies what arrived meanwhile only when newer", async () => {
    const r = rig();
    let answer: (snapshot: StateSnapshot) => void = () => undefined;
    r.nextSnapshot(() => new Promise((resolve) => (answer = resolve)));
    const seen: number[] = [];
    r.service.on("packages", (data) => seen.push(data.generation));
    const started = r.service.start();
    await vi.waitFor(() => {
      expect(r.ipc.snapshot).toHaveBeenCalled();
    });
    expect(r.ipc.onDelta.mock.invocationCallOrder[0]).toBeLessThan(
      r.ipc.snapshot.mock.invocationCallOrder[0] ?? 0,
    );
    // Changes made while the snapshot was on its way: 5 is already in the snapshot, 6 and 7 are not.
    r.deliver(packages(6, 6));
    r.deliver(packages(5, 5));
    r.deliver(packages(7, 7));
    answer(snapshotAt(5, 5));
    await started;
    expect(r.service.currentRevision()).toBe(7);
    expect(r.service.get("packages")).toEqual({ generation: 7 });
    expect(seen).toEqual([5, 6, 7]);
    expect(r.service.active()).toBe(true);
  });

  it("drops a stale delta and applies the next one", async () => {
    const r = rig();
    r.nextSnapshot(() => Promise.resolve(snapshotAt(10, 1)));
    await r.service.start();
    r.deliver(packages(9, 99));
    r.deliver(packages(10, 99));
    expect(r.service.get("packages")).toEqual({ generation: 1 });
    r.deliver(packages(11, 2));
    expect(r.service.currentRevision()).toBe(11);
    expect(r.service.get("packages")).toEqual({ generation: 2 });
  });

  it("a revision gap reads a fresh snapshot, then applies the held deltas after it", async () => {
    const r = rig();
    r.nextSnapshot(() => Promise.resolve(snapshotAt(100, 1)));
    await r.service.start();
    r.nextSnapshot(() => {
      r.deliver(packages(103, 3)); // arrives while the snapshot is read
      return Promise.resolve(snapshotAt(102, 2));
    });
    r.deliver(packages(102, 2)); // 101 never arrived
    await vi.waitFor(() => {
      expect(r.service.currentRevision()).toBe(103);
    });
    expect(r.ipc.snapshot).toHaveBeenCalledTimes(2);
    expect(r.service.get("packages")).toEqual({ generation: 3 });
  });

  /** Every snapshot read sees another delta arrive meanwhile that skips a revision: a gap that never closes. */
  function keepLosingDeltas(r: ReturnType<typeof rig>, reads: number): void {
    for (let i = 1; i <= reads; i++) {
      r.nextSnapshot(() => {
        r.deliver(packages(10 * i + 2, i)); // 10 * i + 1 is lost
        return Promise.resolve(snapshotAt(10 * i, i));
      });
    }
  }

  it("gives up following after repeated gaps instead of reading snapshots forever, and says so once", async () => {
    const r = rig();
    r.nextSnapshot(() => Promise.resolve(snapshotAt(1, 0)));
    await r.service.start();
    keepLosingDeltas(r, 5);
    r.deliver(packages(3, 3)); // 2 is lost
    await vi.waitFor(() => {
      expect(r.service.active()).toBe(false);
    });
    expect(r.ipc.snapshot.mock.calls.length).toBeLessThanOrEqual(4);
    expect(r.failed).toHaveBeenCalledTimes(1);
    // Deltas that arrive while not following aren't kept (the next snapshot covers them).
    r.deliver(packages(99, 99));
    expect(r.service.get("packages")).not.toEqual({ generation: 99 });
  });

  it("after giving up, a catch-up or refresh reads the state again and the window follows once more", async () => {
    const r = rig();
    r.nextSnapshot(() => Promise.resolve(snapshotAt(1, 0)));
    await r.service.start();
    keepLosingDeltas(r, 3);
    r.deliver(packages(3, 3));
    await vi.waitFor(() => {
      expect(r.service.active()).toBe(false);
    });
    r.nextSnapshot(() => Promise.resolve(snapshotAt(50, 50)));
    await r.service.catchUp();
    expect(r.service.active()).toBe(true);
    expect(r.service.currentRevision()).toBe(50);
    r.deliver(packages(51, 51));
    expect(r.service.get("packages")).toEqual({ generation: 51 });
    expect(r.failed).toHaveBeenCalledTimes(1);
  });

  it("a delta held from before a snapshot that claims a newer revision than the snapshot is dropped, not chased", async () => {
    const r = rig();
    r.nextSnapshot(() => Promise.resolve(snapshotAt(1, 0)));
    await r.service.start();
    r.nextSnapshot(() => Promise.resolve(snapshotAt(5, 5))); // the backend is at 5: revision 9 never existed
    r.deliver(packages(9, 9));
    await vi.waitFor(() => {
      expect(r.service.currentRevision()).toBe(5);
    });
    expect(r.service.active()).toBe(true);
    expect(r.ipc.snapshot).toHaveBeenCalledTimes(2);
    expect(r.service.get("packages")).toEqual({ generation: 5 });
    r.deliver(packages(6, 6));
    expect(r.service.get("packages")).toEqual({ generation: 6 });
    expect(r.failed).not.toHaveBeenCalled();
  });

  it("catchUp resolves once the backend's revision was applied, and reads a snapshot if the deltas don't come", async () => {
    const r = rig();
    r.nextSnapshot(() => Promise.resolve(snapshotAt(4, 0)));
    await r.service.start();
    r.setBackendRevision(5);
    const waiting = r.service.catchUp();
    r.deliver(packages(5, 1));
    await waiting;
    expect(r.service.currentRevision()).toBe(5);

    vi.useFakeTimers();
    r.setBackendRevision(8);
    r.nextSnapshot(() => Promise.resolve(snapshotAt(8, 4)));
    const late = r.service.catchUp();
    await vi.advanceTimersByTimeAsync(2100);
    await late;
    expect(r.service.currentRevision()).toBe(8);
  });

  it("stays inactive without a canonical state, and dispose lets go of everything", async () => {
    const r = rig();
    r.nextSnapshot(() => Promise.resolve(null));
    await r.service.start();
    expect(r.service.active()).toBe(false);
    await r.service.catchUp(); // nothing to wait for
    const listener = vi.fn();
    r.service.on("packages", listener);
    r.service.dispose();
    r.deliver(packages(1, 1));
    expect(listener).not.toHaveBeenCalled();
    expect(r.unlisten).toHaveBeenCalled();
  });

  it("a failing listener doesn't stop the others", async () => {
    const r = rig();
    await r.service.start();
    const fine = vi.fn();
    r.service.on("packages", () => {
      throw new Error("broken store");
    });
    r.service.on("packages", fine);
    r.deliver(packages(1, 1));
    expect(fine).toHaveBeenCalledWith({ generation: 1 });
  });

  it("keeps only its own folder's state: another folder's delta or a tick moves the revision and nothing else", async () => {
    const r = rig();
    r.openFolder("c:/a");
    r.nextSnapshot(() =>
      Promise.resolve({
        revision: 3,
        workspace: "c:/a",
        domains: [{ domain: "git", scope: "c:/a", data: { state: "notRepository", git: "Git" } }],
      } as StateSnapshot),
    );
    const seen: unknown[] = [];
    r.service.onWorkspace("git", (data) => seen.push(data));
    await r.service.start();
    expect(r.service.currentWorkspace()).toBe("c:/a");
    expect(r.service.get("git")).toEqual({ state: "notRepository", git: "Git" });

    r.deliver({ revision: 4, domain: "git", scope: "c:/b", data: null, tick: true });
    r.deliver({
      revision: 5,
      domain: "git",
      scope: "c:/b",
      data: { state: "noWorkspace" },
    } as StateDelta);
    expect(r.service.currentRevision()).toBe(5);
    expect(r.service.get("git")).toEqual({ state: "notRepository", git: "Git" });

    r.deliver({
      revision: 6,
      domain: "git",
      scope: "c:/a",
      data: { state: "gitMissing" },
    } as StateDelta);
    expect(r.service.get("git")).toEqual({ state: "gitMissing" });
    r.deliver({ revision: 7, domain: "git", scope: "c:/a", data: null, removed: true });
    expect(r.service.get("git")).toBeUndefined();
    expect(seen).toEqual([
      { state: "notRepository", git: "Git" },
      { state: "gitMissing" },
      undefined,
    ]);
  });

  it("opening another folder drops the old folder's state and reads the snapshot for the new one", async () => {
    const r = rig();
    r.openFolder("c:/a");
    r.nextSnapshot(() =>
      Promise.resolve({
        revision: 2,
        workspace: "c:/a",
        domains: [{ domain: "dependencies", scope: "c:/a", data: { projects: ["a"] } }],
      } as unknown as StateSnapshot),
    );
    await r.service.start();
    expect(r.service.get("dependencies")).toEqual({ projects: ["a"] });
    const seen: unknown[] = [];
    r.service.onWorkspace("dependencies", (data) => seen.push(data));
    r.openFolder("c:/b");
    r.nextSnapshot(() => Promise.resolve({ revision: 2, workspace: "c:/b", domains: [] }));
    await r.service.attachWorkspace();
    expect(r.service.currentWorkspace()).toBe("c:/b");
    expect(r.service.get("dependencies")).toBeUndefined();
    expect(seen).toEqual([undefined]);
    expect(r.ipc.snapshot).toHaveBeenCalledTimes(2);
  });

  it("two quick folder switches attach one after the other, so the window ends on the newest folder", async () => {
    const r = rig();
    r.openFolder("c:/a");
    await r.service.start();
    // The backend answers the first attach slowly; the window switches again meanwhile.
    let answerFirst: (key: string) => void = () => undefined;
    r.ipc.attach.mockImplementationOnce(() => new Promise<string | null>((resolve) => (answerFirst = resolve)));
    r.ipc.attach.mockImplementationOnce(() => Promise.resolve("c:/c"));
    r.nextSnapshot(() => Promise.resolve({ revision: 0, workspace: "c:/b", domains: [] }));
    r.nextSnapshot(() => Promise.resolve({ revision: 0, workspace: "c:/c", domains: [] }));
    const first = r.service.attachWorkspace();
    const second = r.service.attachWorkspace();
    await Promise.resolve();
    expect(r.ipc.attach).toHaveBeenCalledTimes(2); // start-up + the first switch; the second waits its turn
    answerFirst("c:/b");
    await Promise.all([first, second]);
    expect(r.ipc.attach).toHaveBeenCalledTimes(3);
    expect(r.service.currentWorkspace()).toBe("c:/c");
  });

  it("a gap among scoped deltas is recovered from the snapshot like any other", async () => {
    const r = rig();
    r.openFolder("c:/a");
    r.nextSnapshot(() => Promise.resolve({ revision: 10, workspace: "c:/a", domains: [] }));
    await r.service.start();
    r.nextSnapshot(() => {
      r.deliver({ revision: 13, domain: "git", scope: "c:/b", data: null, tick: true }); // while the snapshot is read
      return Promise.resolve({
        revision: 12,
        workspace: "c:/a",
        domains: [{ domain: "debug", scope: "c:/a", data: { workspace: "C:/a" } }],
      } as unknown as StateSnapshot);
    });
    r.deliver({ revision: 12, domain: "git", scope: "c:/b", data: null, tick: true }); // 11 missing
    await vi.waitFor(() => {
      expect(r.service.currentRevision()).toBe(13);
    });
    expect(r.service.get("debug")).toEqual({ workspace: "C:/a" });
  });

  it("refresh asks the backend and then waits for the result", async () => {
    const r = rig();
    r.openFolder("c:/a");
    r.nextSnapshot(() => Promise.resolve({ revision: 0, workspace: "c:/a", domains: [] }));
    await r.service.start();
    r.setBackendRevision(1);
    const done = r.service.refresh(["git"]);
    await vi.waitFor(() => {
      expect(r.ipc.refresh).toHaveBeenCalledWith(["git"]);
    });
    r.deliver({
      revision: 1,
      domain: "git",
      scope: "c:/a",
      data: { state: "noWorkspace" },
    } as StateDelta);
    await done;
    expect(r.service.get("git")).toEqual({ state: "noWorkspace" });
  });
});
