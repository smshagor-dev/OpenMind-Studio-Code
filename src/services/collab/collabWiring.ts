import { t } from "../../i18n";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { languageForPath } from "../../editor/languageForPath";
import type { CanonicalFeed } from "../state/canonicalStateService";
import type { CollabSnapshot } from "./collabIpc";
import { acquireModel, releaseModel } from "../../editor/collabModels";
import type { DocumentService } from "../documentService";
import type { EventBus } from "../eventBus";
import type { AppEvents } from "../events";
import type { FilePreviewService } from "../filePreviewService";
import type { WorkspaceService } from "../workspaceService";
import { tauriCollabDocIpc, type CollabDocIpc } from "./collabDocIpc";
import { CollabDocService } from "./collabDocService";
import { tauriCollabNetIpc, type CollabNetIpc } from "./collabNetIpc";
import { wirePresence } from "./presenceWiring";
import { RoomManagementService } from "./roomManagementService";
import { wireVoice } from "./voice/voiceWiring";
import type { VoiceService } from "./voice/voiceService";
import { tauriRoomIpc, type RoomIpc } from "./roomIpc";
import type { PresenceService } from "./presenceService";
import type { NetRooms } from "./presenceWiring";
import { isCollabUri, parseCollabUri } from "./remoteTree";
import { RemoteWorkspaceService } from "./remoteWorkspaceService";

export interface CollabWiringDeps {
  workspace: WorkspaceService;
  documents: DocumentService;
  filePreviews: FilePreviewService;
  events: EventBus<AppEvents>;
  /** The editor language of a path (default: the app's table). */
  languageOf?: (path: string) => string;
  roomIpc?: RoomIpc;
  copy?: (text: string) => Promise<void>;
  /** The canonical state: the rooms and members (names, membership). */
  canonical?: { feed: (domain: "collaboration") => CanonicalFeed<CollabSnapshot> };
  ipc?: CollabNetIpc;
  docIpc?: CollabDocIpc;
}

/**
 * A room's shared workspace and collaborative editing in this window (Milestone 24, phases 5-6):
 *
 * - remote files open through the read-only custom-scheme tab (`omcollab://<room>/<file id>`); a text file then
 *   becomes a live collaborative document on the same model, editable while this member may change files;
 * - on the Owner's side, the editor document of a file a participant opened is held and joins the shared document;
 * - closing a tab stops a running transfer and leaves the document; a reconnect syncs every open document again.
 */
export function wireCollab(deps: CollabWiringDeps): {
  remote: RemoteWorkspaceService;
  docs: CollabDocService;
  presence: PresenceService;
  rooms: NetRooms;
  manage: RoomManagementService;
  voice: VoiceService;
  collaboration: CanonicalFeed<CollabSnapshot> | null;
  start: () => Promise<() => void>;
} {
  const error = (message: string): void => {
    deps.events.emit("appError", { message });
  };
  const docs = docService(deps, error);
  const netIpc = deps.ipc ?? tauriCollabNetIpc;
  const remote = new RemoteWorkspaceService(netIpc, {
    openDocument: (request) => {
      deps.workspace.openVirtualDocument(request);
      void docs
        .openRemote(request.collab.roomUid, request.collab.fileId, request.uri, request.language)
        .catch((err: unknown) => {
          error(String(err));
        });
    },
    markDocument: (uri, state) => {
      deps.filePreviews.setCollabState(uri, state);
    },
    isLive: (uri) => docs.isLive(uri),
    renamed: (uri, path) => {
      deps.filePreviews.setCollabPath(uri, path);
    },
    languageOf: deps.languageOf ?? languageForPath,
    notice: (message) => {
      deps.events.emit("appNotice", { message });
    },
    error,
  });
  deps.filePreviews.onRelease((doc) => {
    if (!isCollabUri(doc.path)) return;
    remote.documentClosed(doc.path);
    if (parseCollabUri(doc.path)) docs.closeRemote(doc.path);
  });
  const presence = wirePresence({ docs, documents: deps.documents, netIpc });
  const rooms = presence.rooms;
  const manage = management(deps, netIpc, rooms, error);
  const voice = wireVoice({
    netIpc,
    rooms,
    notice: (message) => {
      deps.events.emit("appNotice", { message });
    },
  });
  const start = async (): Promise<() => void> => {
    const stops = await Promise.all([
      remote.start(),
      docs.start(),
      presence.start(),
      manage.start(),
      voice.start(),
      netIpc.onNet((payload) => {
        // Joined again (a fresh session): every open document syncs both ways.
        if (payload.side === "participant" && payload.event.kind === "route")
          void docs.resync(payload.roomUid);
      }),
    ]);
    return () => {
      for (const stop of stops) stop();
    };
  };
  return {
    remote,
    docs,
    presence: presence.presence,
    rooms: presence.rooms,
    manage,
    voice: voice.voice,
    collaboration: deps.canonical?.feed("collaboration") ?? null,
    start,
  };
}

/** Collaborative documents in this window: the participant's `omcollab:` models, the Owner's held editor documents. */
function docService(deps: CollabWiringDeps, error: (message: string) => void): CollabDocService {
  return new CollabDocService(deps.docIpc ?? tauriCollabDocIpc, {
    remoteModel: (uri, language) => {
      const model = acquireModel(uri, "", language);
      return {
        model,
        release: () => {
          releaseModel(uri, model);
        },
      };
    },
    setLive: (uri, editable) => {
      deps.filePreviews.setCollabLive(uri, editable);
    },
    setUnavailable: (uri) => {
      deps.filePreviews.setCollabState(uri, "unavailable");
    },
    openHeld: async (path) => {
      const id = await deps.documents.openFromPath(path).catch(() => null);
      const model = id === null ? null : deps.documents.modelFor(id);
      if (id === null || model === null) return null;
      deps.documents.hold(id);
      return {
        docId: id,
        model,
        dirty: deps.documents.isDirty(id),
        saved: deps.documents.savedText(id),
      };
    },
    releaseHeld: (docId) => {
      deps.documents.release(docId);
    },
    keepApart: (path, text) => {
      const id = deps.workspace.createUntitled();
      deps.documents.modelFor(id)?.setValue(text);
      const name = path.split(/[\\/]/).pop() ?? path;
      deps.events.emit("appNotice", {
        message: t("collab.keptApart", { name }),
      });
    },
    error,
  });
}

/** Room management: commands run here for hosted rooms, sent to the Owner for joined ones. */
function management(
  deps: CollabWiringDeps,
  netIpc: CollabNetIpc,
  rooms: NetRooms,
  error: (message: string) => void,
): RoomManagementService {
  return new RoomManagementService(deps.roomIpc ?? tauriRoomIpc, netIpc, {
    side: (roomUid) =>
      rooms.status.hosting.includes(roomUid)
        ? "host"
        : rooms.status.joined.includes(roomUid)
          ? "participant"
          : null,
    refreshRooms: () => rooms.read(),
    copy: deps.copy ?? ((text) => writeText(text)),
    error,
  });
}
