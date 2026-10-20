import type { CollabNetIpc, NetDiagnostics } from "./collabNetIpc";
import type { CollabRole } from "./presenceIpc";
import {
  errorText,
  joinError,
  type JoinError,
  type JoinStage,
  type PermissionModel,
  type RoomCommand,
  type RoomIpc,
} from "./roomIpc";

export interface RoomManagementHost {
  /** Which side of `roomUid` this computer is on (`null`: not on the network with it). */
  side: (roomUid: string) => "host" | "participant" | null;
  /** Reads the network status again (after creating, joining or leaving a room). */
  refreshRooms: () => Promise<void>;
  copy: (text: string) => Promise<void>;
  error: (message: string) => void;
}

interface JoinProgress {
  busy: boolean;
  stage: JoinStage | null;
  error: JoinError | null;
  /** A rejoin's room (shown next to it); `null` for a join with a code. */
  room: string | null;
}

const IDLE: JoinProgress = { busy: false, stage: null, error: null, room: null };

/**
 * Room management in this window (Milestone 24, phase 8). Every action goes to the backend — a room this computer
 * hosts runs it as its own user, a joined room sends it to the Owner — and the panel then shows what the backend's
 * state says (the canonical `collaboration` domain, the Owner's room view): nothing is changed here first, so two
 * moderators acting at once simply see the Owner's result. A refusal comes back as the Owner's reason.
 *
 * A Room Code is fetched only when the user reveals it, kept in memory only while shown, and never logged.
 */
export class RoomManagementService {
  private listeners = new Set<() => void>();
  private version = 0;
  private codes = new Map<string, string>();
  private busy = new Set<string>();
  private join: JoinProgress = IDLE;
  private model: PermissionModel | null = null;
  private me: string | null = null;

  constructor(
    private readonly ipc: RoomIpc,
    private readonly net: CollabNetIpc,
    private readonly host: RoomManagementHost,
  ) {}

  async start(): Promise<() => void> {
    const stop = await this.ipc.onJoin((stage) => {
      if (!this.join.busy) return;
      this.join = { ...this.join, stage };
      this.changed();
    });
    void this.ipc
      .identity()
      .then((identity) => {
        this.me = identity.peerId;
        this.changed();
      })
      .catch(() => undefined);
    return stop;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  /** This computer's peer id (the same in every room), once read. */
  identity(): string | null {
    return this.me;
  }

  joinProgress(): JoinProgress {
    return this.join;
  }

  isBusy(roomUid: string): boolean {
    return this.busy.has(roomUid);
  }

  /** The backend's permission model (read once, on first use). */
  async permissionModel(): Promise<PermissionModel> {
    this.model ??= await this.ipc.permissionModel();
    return this.model;
  }

  /** Runs commands in order on `roomUid` (stops at the first refusal). `true` when every one was accepted. */
  async run(roomUid: string, commands: RoomCommand[]): Promise<boolean> {
    const side = this.host.side(roomUid);
    if (side === null) return false;
    this.busy.add(roomUid);
    this.changed();
    try {
      for (const command of commands) {
        if (side === "host") await this.ipc.hostCommand(roomUid, command);
        else await this.ipc.remoteCommand(roomUid, command);
      }
      if (commands.some((c) => c.command === "rotateInvite") && this.codes.has(roomUid))
        await this.reveal(roomUid);
      return true;
    } catch (err) {
      this.host.error(errorText(err));
      return false;
    } finally {
      this.busy.delete(roomUid);
      this.changed();
    }
  }

  setRole(roomUid: string, target: string, role: CollabRole): Promise<boolean> {
    return this.run(roomUid, [{ command: "changeRole", target, role }]);
  }

  /** The Room Code while it is shown (`null`: hidden). */
  code(roomUid: string): string | null {
    return this.codes.get(roomUid) ?? null;
  }

  async reveal(roomUid: string): Promise<void> {
    try {
      this.codes.set(roomUid, await this.ipc.invite(roomUid));
    } catch (err) {
      this.host.error(errorText(err));
    }
    this.changed();
  }

  hide(roomUid: string): void {
    if (this.codes.delete(roomUid)) this.changed();
  }

  /** Copies the Room Code (fetched for the copy only when it isn't shown). */
  async copyCode(roomUid: string): Promise<void> {
    try {
      const code = this.codes.get(roomUid) ?? (await this.ipc.invite(roomUid));
      await this.host.copy(code);
    } catch (err) {
      this.host.error(errorText(err));
    }
  }

  /** Creates a room for this window's folder and offers it on the network; its Room Code is shown. */
  async create(name: string): Promise<string | null> {
    try {
      const created = await this.ipc.create(name.trim());
      this.codes.set(created.roomUid, created.code);
      await this.net.hostStart(created.roomUid);
      await this.host.refreshRooms();
      return created.roomUid;
    } catch (err) {
      this.host.error(errorText(err));
      return null;
    } finally {
      this.changed();
    }
  }

  /** Joins with a Room Code. `null` on success. */
  async joinRoom(code: string): Promise<JoinError | null> {
    this.join = { busy: true, stage: "connecting", error: null, room: null };
    this.changed();
    try {
      await this.net.join(code.trim(), null);
      this.join = { busy: false, stage: "connected", error: null, room: null };
      await this.host.refreshRooms();
      return null;
    } catch (err) {
      const error = joinError(err);
      this.join = { ...this.join, busy: false, stage: "failed", error };
      return error;
    } finally {
      this.changed();
    }
  }

  /** Offers a room created here on the network again (its folder must be open in this window; the backend checks). */
  async hostAgain(roomUid: string): Promise<void> {
    try {
      await this.net.hostStart(roomUid);
      await this.host.refreshRooms();
    } catch (err) {
      this.host.error(errorText(err));
    }
    this.changed();
  }

  /** Reconnects to a room joined before (the Owner's key pinned at the first join is checked). */
  async rejoin(roomUid: string): Promise<JoinError | null> {
    this.join = { busy: true, stage: "connecting", error: null, room: roomUid };
    this.changed();
    try {
      await this.net.rejoin(roomUid, null);
      this.join = IDLE;
      await this.host.refreshRooms();
      return null;
    } catch (err) {
      const error = joinError(err);
      this.join = { ...this.join, busy: false, stage: "failed", error };
      return error;
    } finally {
      this.changed();
    }
  }

  resetJoin(): void {
    this.join = IDLE;
    this.changed();
  }

  async leave(roomUid: string): Promise<void> {
    try {
      await this.net.leave(roomUid);
      this.codes.delete(roomUid);
      await this.host.refreshRooms();
    } catch (err) {
      this.host.error(errorText(err));
    }
    this.changed();
  }

  diagnostics(): Promise<NetDiagnostics> {
    return this.net.diagnostics();
  }

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}
