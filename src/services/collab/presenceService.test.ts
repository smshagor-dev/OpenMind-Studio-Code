import { describe, expect, it, vi } from "vitest";

import type { PresenceEventPayload, PresenceIpc, PresenceState } from "./presenceIpc";
import {
  COLLAB_COLORS,
  PRESENCE_EXPIRY_MS,
  PresenceService,
  colorOf,
  type Clock,
} from "./presenceService";

class FakeClock implements Clock {
  t = 1000;
  timers: { at: number; run: () => void; id: number }[] = [];
  private next = 1;
  now = (): number => this.t;
  setTimer = (run: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, run, id });
    return id;
  };
  clearTimer = (timer: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== timer);
  };
  advance(ms: number): void {
    this.t += ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      this.timers = this.timers.filter((x) => x !== due);
      due.run();
    }
  }
}

function ipc(): PresenceIpc & { emit: (p: PresenceEventPayload) => void } {
  let listener: ((p: PresenceEventPayload) => void) | null = null;
  return {
    set: vi.fn(() => Promise.resolve()),
    snapshot: vi.fn(() =>
      Promise.resolve({
        me: "me",
        roster: [{ peer: "a", displayName: "Ana", role: "editor" as const, online: true }],
        peers: [
          { peer: "me", state: st(1, "f1"), activePath: null },
          { peer: "a", state: st(3, "f1"), activePath: null },
        ],
        room: null,
      }),
    ),
    onPresence: (l) => {
      listener = l;
      return Promise.resolve(() => {
        listener = null;
      });
    },
    emit: (p) => listener?.(p),
  };
}

function st(seq: number, active: string | null, typing = false): PresenceState {
  return { seq, active, cursor: active ? { anchor: "AQ==", head: "AQ==" } : null, typing };
}

const peer = (
  p: string,
  s: PresenceState,
  activePath: string | null = null,
): PresenceEventPayload => ({
  roomUid: "r",
  side: "participant",
  event: { kind: "peer", peer: p, state: s, activePath },
});

describe("PresenceService", () => {
  it("keeps the newest state per member and ignores older ones", async () => {
    const fake = ipc();
    const service = new PresenceService(fake, new FakeClock());
    await service.start();
    fake.emit(peer("a", st(2, "f1")));
    fake.emit(peer("a", st(1, "f2")));
    expect(service.peers("r").map((p) => p.state.seq)).toEqual([2]);
    fake.emit(peer("a", st(3, "f2")));
    expect(service.inFile("r", "f2").map((c) => c.peer)).toEqual(["a"]);
    expect(service.inFile("r", "f1")).toEqual([]);
  });

  it("names members and gives roles only from the Owner's roster", async () => {
    const fake = ipc();
    const service = new PresenceService(fake, new FakeClock());
    await service.start();
    fake.emit(peer("a", st(1, "f1")));
    expect(service.inFile("r", "f1")[0]).toMatchObject({ name: "", role: null });
    fake.emit({
      roomUid: "r",
      side: "participant",
      event: {
        kind: "roster",
        members: [{ peer: "a", displayName: "Ana", role: "viewer", online: true }],
      },
    });
    expect(service.inFile("r", "f1")[0]).toMatchObject({ name: "Ana", role: "viewer" });
    fake.emit({
      roomUid: "r",
      side: "participant",
      event: {
        kind: "roster",
        members: [{ peer: "a", displayName: "Ana", role: "editor", online: true }],
      },
    });
    expect(service.inFile("r", "f1")[0]?.role).toBe("editor");
  });

  it("tells active-file listeners only about who is where, not cursor moves", async () => {
    const fake = ipc();
    const service = new PresenceService(fake, new FakeClock());
    await service.start();
    const all = vi.fn();
    const where = vi.fn();
    service.subscribe(all);
    service.subscribeActive(where);
    fake.emit(peer("a", st(1, "f1")));
    fake.emit(peer("a", { ...st(2, "f1"), cursor: { anchor: "Ag==", head: "Aw==" } }));
    fake.emit(peer("a", { ...st(3, "f1"), cursor: { anchor: "BA==", head: "BA==" } }));
    expect(all).toHaveBeenCalledTimes(3);
    expect(where).toHaveBeenCalledTimes(1);
    fake.emit(peer("a", st(4, "f1", true)));
    expect(where).toHaveBeenCalledTimes(2);
  });

  it("expires a silent member, keeps one that heartbeats, and clears on leave and reset", async () => {
    const fake = ipc();
    const clock = new FakeClock();
    const service = new PresenceService(fake, clock);
    await service.start();
    fake.emit(peer("a", st(1, "f1")));
    fake.emit(peer("b", st(1, "f1")));
    clock.advance(PRESENCE_EXPIRY_MS - 5000);
    fake.emit(peer("b", st(1, "f1"))); // the same state again: a heartbeat
    clock.advance(6000);
    expect(service.peers("r").map((p) => p.peer)).toEqual(["b"]);
    expect(clock.timers.length).toBe(1);
    fake.emit({ roomUid: "r", side: "participant", event: { kind: "gone", peer: "b" } });
    expect(service.peers("r")).toEqual([]);
    expect(clock.timers.length).toBe(0);
    fake.emit(peer("c", st(1, "f1")));
    fake.emit({ roomUid: "r", side: "participant", event: { kind: "reset" } });
    expect(service.peers("r")).toEqual([]);
  });

  it("loads a snapshot without listing this computer itself", async () => {
    const fake = ipc();
    const service = new PresenceService(fake, new FakeClock());
    await service.load("r", "participant");
    expect(service.peers("r").map((p) => p.peer)).toEqual(["a"]);
    fake.emit(peer("me", st(9, "f1")));
    await service.start();
    fake.emit(peer("me", st(10, "f1")));
    expect(service.peers("r").map((p) => p.peer)).toEqual(["a"]);
    expect(service.nameOf("r", "a")).toBe("Ana");
  });

  it("finds Owner-side collaborators by path, ignoring case and slash style", async () => {
    const fake = ipc();
    const service = new PresenceService(fake, new FakeClock());
    await service.start();
    fake.emit({ ...peer("a", st(1, "f1"), "C:\\Work\\Src\\A.ts"), side: "host" });
    expect(service.atPath("c:/work/src/a.ts").map((c) => c.peer)).toEqual(["a"]);
    expect(service.insideFolder("C:/Work").map((c) => c.peer)).toEqual(["a"]);
    expect(service.insideFolder("C:/Wor")).toEqual([]);
  });

  it("gives every peer a stable colour within the palette", () => {
    const peers = Array.from({ length: 50 }, (_, i) => `peer-${i}`);
    for (const p of peers) {
      expect(colorOf(p)).toBe(colorOf(p));
      expect(colorOf(p)).toBeGreaterThanOrEqual(1);
      expect(colorOf(p)).toBeLessThanOrEqual(COLLAB_COLORS);
    }
    expect(new Set(peers.map(colorOf)).size).toBeGreaterThan(4);
  });

  it("follows a renamed file on the Owner's computer with the same state", async () => {
    const fake = ipc();
    const service = new PresenceService(fake, new FakeClock());
    await service.start();
    const all = vi.fn();
    service.subscribeActive(all);
    fake.emit({ ...peer("a", st(4, "f1"), "C:/w/old.ts"), side: "host" });
    fake.emit({ ...peer("a", st(4, "f1"), "C:/w/new.ts"), side: "host" });
    expect(service.atPath("C:/w/old.ts")).toEqual([]);
    expect(service.atPath("C:/w/new.ts").map((c) => c.peer)).toEqual(["a"]);
    expect(all).toHaveBeenCalledTimes(2);
  });
});
