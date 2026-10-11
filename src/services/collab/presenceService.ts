import type {
  CollabRole,
  PresenceEventPayload,
  PresenceIpc,
  PresenceState,
  RosterEntry,
} from "./presenceIpc";
import { parseCollabUri } from "./remoteTree";
import type { RoomView } from "./roomIpc";

/** A member that hasn't been heard from for this long is no longer shown (a heartbeat comes every 10 s). */
export const PRESENCE_EXPIRY_MS = 30_000;
/** Colours `--collab-1` … `--collab-8` (theme tokens). */
export const COLLAB_COLORS = 8;

export interface PeerPresence {
  peer: string;
  state: PresenceState;
  /** Owner only: where `state.active` is on this computer. */
  activePath: string | null;
  /** When it was last heard from (this window's clock). */
  at: number;
}

interface RoomPresence {
  side: "host" | "participant";
  roster: RosterEntry[];
  peers: Map<string, PeerPresence>;
}

/** One collaborator as indicators show it. */
export interface Collaborator {
  peer: string;
  name: string;
  role: CollabRole | null;
  color: number;
  typing: boolean;
}

export interface Clock {
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

/** A peer's colour, the same in every window and on every computer (from its id, not from arrival order). */
export function colorOf(peer: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < peer.length; i += 1) {
    hash ^= peer.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % COLLAB_COLORS) + 1;
}

/** A path as one key: forward slashes, no trailing slash, case ignored (the Owner's computer is Windows-first). */
export function pathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Other members' presence in this window (Milestone 24, phase 7) — ephemeral, never stored, never canonical. It follows
 * `collab:presence`: the Owner's roster (names, roles, online, from membership) and each member's latest state, which
 * expires after [`PRESENCE_EXPIRY_MS`] of silence, on leaving and when the connection ends.
 *
 * Two kinds of listener keep redraws cheap: `subscribe` hears every change (cursors move often), `subscribeActive`
 * only changes of *who is where* — roster, active files, typing — so the Explorer and tabs never redraw for a cursor.
 */
export class PresenceService {
  private rooms = new Map<string, RoomPresence>();
  private me = new Map<string, string>();
  /** Participant rooms: what the Owner lets this member see and manage (phase 8). */
  private views = new Map<string, RoomView>();
  private listeners = new Set<() => void>();
  private activeListeners = new Set<() => void>();
  private version = 0;
  private activeVersion = 0;
  private timer: unknown = null;

  constructor(
    private readonly ipc: PresenceIpc,
    private readonly clock: Clock = realClock,
  ) {}

  async start(): Promise<() => void> {
    const stop = await this.ipc.onPresence((payload) => {
      this.handle(payload);
    });
    return () => {
      stop();
      if (this.timer !== null) this.clock.clearTimer(this.timer);
      this.timer = null;
    };
  }

  /** Reads a room's current presence (a window that opens while others are already there). */
  async load(roomUid: string, side: "host" | "participant"): Promise<void> {
    const snapshot = await this.ipc.snapshot(roomUid);
    this.me.set(roomUid, snapshot.me);
    if (snapshot.room) this.views.set(roomUid, snapshot.room);
    const room = this.roomOf(roomUid, side);
    room.roster = snapshot.roster;
    for (const p of snapshot.peers) {
      if (p.peer === snapshot.me) continue;
      const known = room.peers.get(p.peer);
      if (known && known.state.seq >= p.state.seq) continue;
      room.peers.set(p.peer, { ...p, at: this.clock.now() });
    }
    this.changed(true);
  }

  handle({ roomUid, side, event }: PresenceEventPayload): void {
    const room = this.roomOf(roomUid, side);
    switch (event.kind) {
      case "roster":
        room.roster = event.members;
        this.changed(true);
        return;
      case "peer": {
        if (event.peer === this.me.get(roomUid)) return;
        const known = room.peers.get(event.peer);
        if (known && known.state.seq > event.state.seq) return; // arrived late
        if (known && known.state.seq === event.state.seq && known.activePath === event.activePath) {
          known.at = this.clock.now(); // a heartbeat of the same state
          this.schedule();
          return;
        }
        room.peers.set(event.peer, {
          peer: event.peer,
          state: event.state,
          activePath: event.activePath,
          at: this.clock.now(),
        });
        const whereChanged =
          !known ||
          known.state.active !== event.state.active ||
          known.state.typing !== event.state.typing ||
          known.activePath !== event.activePath;
        this.changed(whereChanged);
        return;
      }
      case "gone":
        if (room.peers.delete(event.peer)) this.changed(true);
        return;
      case "room":
        this.views.set(roomUid, event.view);
        this.changed(true);
        return;
      case "reset":
        room.peers.clear();
        room.roster = [];
        this.views.delete(roomUid);
        this.changed(true);
        return;
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeActive(listener: () => void): () => void {
    this.activeListeners.add(listener);
    return () => {
      this.activeListeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  getActiveVersion(): number {
    return this.activeVersion;
  }

  /** Participant: the Owner's last room view for this member (`null` on the Owner's computer or before one came). */
  roomView(roomUid: string): RoomView | null {
    return this.views.get(roomUid) ?? null;
  }

  /** This computer's own peer in `roomUid` (known once the room's presence was read). */
  meOf(roomUid: string): string | null {
    return this.me.get(roomUid) ?? null;
  }

  roster(roomUid: string): RosterEntry[] {
    return this.rooms.get(roomUid)?.roster ?? [];
  }

  side(roomUid: string): "host" | "participant" | null {
    return this.rooms.get(roomUid)?.side ?? null;
  }

  peers(roomUid: string): PeerPresence[] {
    return [...(this.rooms.get(roomUid)?.peers.values() ?? [])];
  }

  /** Others with `fileId` of `roomUid` active. */
  inFile(roomUid: string, fileId: string): Collaborator[] {
    return this.peers(roomUid)
      .filter((p) => p.state.active === fileId)
      .map((p) => this.collaborator(roomUid, p));
  }

  /** Owner: others with the file at `path` on this computer active (any hosted room). */
  atPath(path: string): Collaborator[] {
    const key = pathKey(path);
    const out: Collaborator[] = [];
    for (const [roomUid, room] of this.rooms) {
      for (const p of room.peers.values()) {
        if (p.activePath !== null && pathKey(p.activePath) === key)
          out.push(this.collaborator(roomUid, p));
      }
    }
    return out;
  }

  /** Owner: others somewhere inside the folder at `path` (a collapsed folder's indicator). */
  insideFolder(path: string): Collaborator[] {
    const prefix = `${pathKey(path)}/`;
    const out: Collaborator[] = [];
    for (const [roomUid, room] of this.rooms) {
      for (const p of room.peers.values()) {
        if (p.activePath !== null && pathKey(p.activePath).startsWith(prefix))
          out.push(this.collaborator(roomUid, p));
      }
    }
    return out;
  }

  /**
   * Who else has the document at `path` active: an `omcollab:` document by room and file, an Owner's file by its path,
   * or — for a collapsed folder — anything inside it.
   */
  here(path: string, folder: boolean): Collaborator[] {
    const remote = parseCollabUri(path);
    if (remote) return this.inFile(remote.roomUid, remote.fileId);
    return folder ? this.insideFolder(path) : this.atPath(path);
  }

  /** The name the Owner's roster gives `peer` (never a name a member chose for itself on the wire). */
  nameOf(roomUid: string, peer: string): string | null {
    return this.roster(roomUid).find((m) => m.peer === peer)?.displayName ?? null;
  }

  private collaborator(roomUid: string, p: PeerPresence): Collaborator {
    const entry = this.roster(roomUid).find((m) => m.peer === p.peer);
    return {
      peer: p.peer,
      name: entry?.displayName ?? "",
      role: entry?.role ?? null,
      color: colorOf(p.peer),
      typing: p.state.typing,
    };
  }

  private roomOf(roomUid: string, side: "host" | "participant"): RoomPresence {
    let room = this.rooms.get(roomUid);
    if (!room) {
      room = { side, roster: [], peers: new Map() };
      this.rooms.set(roomUid, room);
    }
    return room;
  }

  private changed(where: boolean): void {
    this.version += 1;
    if (where) this.activeVersion += 1;
    this.schedule();
    for (const listener of [...this.listeners]) listener();
    if (where) for (const listener of [...this.activeListeners]) listener();
  }

  /** One timer for the next expiry (no polling). */
  private schedule(): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    let next = Infinity;
    for (const room of this.rooms.values())
      for (const p of room.peers.values()) next = Math.min(next, p.at + PRESENCE_EXPIRY_MS);
    if (next === Infinity) return;
    this.timer = this.clock.setTimer(
      () => {
        this.timer = null;
        this.expire();
      },
      Math.max(0, next - this.clock.now()),
    );
  }

  private expire(): void {
    const now = this.clock.now();
    let removed = false;
    for (const room of this.rooms.values()) {
      for (const [peer, p] of room.peers) {
        if (now - p.at >= PRESENCE_EXPIRY_MS) removed = room.peers.delete(peer) || removed;
      }
    }
    if (removed) this.changed(true);
    else this.schedule();
  }
}
