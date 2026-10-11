import { followEditors, labelStyle } from "../../editor/presenceEditors";
import { RemoteCursors } from "../../editor/remoteCursors";
import type { DocumentService } from "../documentService";
import type { CollabDocService } from "./collabDocService";
import type { CollabNetIpc, NetStatus } from "./collabNetIpc";
import { tauriPresenceIpc, type PresenceIpc } from "./presenceIpc";
import { PresencePublisher } from "./presencePublisher";
import { PresenceService } from "./presenceService";

export interface PresenceWiringDeps {
  docs: CollabDocService;
  documents: DocumentService;
  netIpc: CollabNetIpc;
  ipc?: PresenceIpc;
}

/** The rooms this computer is on the network with now (follows `collab:net`; read on start and after each event). */
export class NetRooms {
  status: NetStatus = { hosting: [], joined: [], states: {}, lanEndpoints: {}, routes: {} };
  private reading = false;
  private requests = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly ipc: CollabNetIpc) {}

  /** Reads the status once (requests that arrive meanwhile read once more afterwards). */
  async read(): Promise<void> {
    this.requests += 1;
    if (this.reading) return;
    this.reading = true;
    try {
      while (this.requests > 0) {
        this.requests = 0;
        // A failed or empty answer (a test double without a backend) keeps the last known status.
        const next = (await this.ipc.status().catch(() => this.status)) as NetStatus | undefined;
        this.status = next ?? this.status;
        for (const listener of [...this.listeners]) listener();
      }
    } finally {
      this.reading = false;
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * Presence in this window (Milestone 24, phase 7): the store of other members' presence, this window's publisher and
 * the remote cursors, wired to the editors, the collaborative documents and the network state.
 */
export function wirePresence(deps: PresenceWiringDeps): {
  presence: PresenceService;
  rooms: NetRooms;
  start: () => Promise<() => void>;
} {
  const ipc = deps.ipc ?? tauriPresenceIpc;
  const presence = new PresenceService(ipc);
  const rooms = new NetRooms(deps.netIpc);
  const publisher = new PresencePublisher(ipc, {
    liveFor: (model) => deps.docs.liveFor(model as Parameters<CollabDocService["liveFor"]>[0]),
    onDocChange: (listener) => deps.docs.onChange(listener),
    hostedRooms: () => rooms.status.hosting,
    pathOf: (model) => {
      const uri = (model as { uri?: { toString: () => string } }).uri?.toString();
      const id = uri === undefined ? undefined : deps.documents.idForModelUri(uri);
      return id === undefined ? null : deps.documents.snapshot(id).path;
    },
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
  });
  const cursors = new RemoteCursors(
    {
      liveFor: (model) => deps.docs.liveFor(model as Parameters<CollabDocService["liveFor"]>[0]),
      peers: (roomUid) => presence.peers(roomUid),
      nameOf: (roomUid, peer) => presence.nameOf(roomUid, peer),
    },
    labelStyle(),
  );
  // Cursor redraws are gathered into one per task (a burst of presence states and remote edits draws once).
  let drawing = false;
  const draw = (): void => {
    if (drawing) return;
    drawing = true;
    queueMicrotask(() => {
      drawing = false;
      cursors.render();
    });
  };
  const loaded = new Set<string>();
  const loadRooms = (): void => {
    loadNewRooms(rooms.status, loaded, presence);
    publisher.refresh();
  };
  const start = async (): Promise<() => void> => {
    const stops = [
      await presence.start(),
      publisher.start(),
      presence.subscribe(draw),
      deps.docs.onChange((_room, _file, local) => {
        draw();
        if (!local) publisher.refresh();
      }),
      rooms.subscribe(loadRooms),
      await deps.netIpc.onNet((payload) => {
        // A fresh session (joined again): read the room's presence again.
        if (payload.side === "participant" && payload.event.kind === "route")
          loaded.delete(payload.roomUid);
        void rooms.read();
      }),
      followEditors(publisher, cursors),
    ];
    void rooms.read();
    return () => {
      for (const stop of stops) stop();
    };
  };
  return { presence, rooms, start };
}

/** Reads the presence of rooms that just came on the network; forgets rooms that left it. */
function loadNewRooms(status: NetStatus, loaded: Set<string>, presence: PresenceService): void {
  const { hosting, joined } = status;
  const all = [
    ...hosting.map((r) => [r, "host"] as const),
    ...joined.map((r) => [r, "participant"] as const),
  ];
  for (const [room, side] of all) {
    if (loaded.has(room)) continue;
    loaded.add(room);
    void presence.load(room, side).catch(() => loaded.delete(room));
  }
  for (const room of loaded)
    if (!hosting.includes(room) && !joined.includes(room)) loaded.delete(room);
}
