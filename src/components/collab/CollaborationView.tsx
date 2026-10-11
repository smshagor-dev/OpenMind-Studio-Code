import { useState, useSyncExternalStore } from "react";

import "../../styles/collab.css";

import { t } from "../../i18n";
import { container } from "../../services/container";
import type { CollabSnapshot } from "../../services/collab/collabIpc";
import { baseName, panelRooms } from "../../services/collab/collabPanelModel";
import type { PeerPresence } from "../../services/collab/presenceService";
import { CollabDiagnostics } from "./CollabDiagnostics";
import { CreateRoomForm, JoinRoomForm } from "./CollabForms";
import { RoomSection } from "./RoomSection";
import { SharedFiles } from "./SharedFiles";
import { StoredRooms } from "./StoredRooms";

const NO_FEED = { subscribe: () => () => undefined, current: () => undefined };

function useCollabSnapshot(): CollabSnapshot | undefined {
  const feed = container.collab.collaboration ?? NO_FEED;
  return useSyncExternalStore((listener) => feed.subscribe(listener), feed.current);
}

/** A file's display name for a member's active file: the shared tree's name (participant) or the local file's. */
function fileName(roomUid: string, peer: PeerPresence): string | null {
  if (peer.activePath !== null) return baseName(peer.activePath);
  const id = peer.state.active;
  if (id === null) return null;
  const entry = container.collab.remote.room(roomUid).tree.entries.get(id);
  return entry ? entry.name : null;
}

/**
 * The Collaboration panel (Milestone 24, phases 7-8): create or join a room, and for each room this computer hosts
 * or joined — its state, Room Code (the Owner's computer only, hidden until revealed), controls, join requests,
 * members by role with a management menu where this member may act, banned members, and (participants) the shared
 * files. Every action is the backend's to decide; the panel shows the backend's state afterwards. No fingerprint,
 * key, ICE or STUN detail is shown here (diagnostics are behind their own button).
 */
export function CollaborationView() {
  const { presence, rooms, manage } = container.collab;
  useCollabStores();
  const explorer = useSyncExternalStore(
    (l) => container.explorer.subscribe(l),
    () => container.explorer.getSnapshot(),
  );
  const snapshot = useCollabSnapshot();
  const [form, setForm] = useState<Form>(null);
  const [diagnostics, setDiagnostics] = useState(false);
  const panels = panelRooms({
    status: rooms.status,
    rooms: snapshot?.rooms ?? [],
    view: (r) => presence.roomView(r),
    peers: (r) => presence.peers(r),
    me: manage.identity(),
    fileName,
    voice: (r) => container.collab.voice.roster(r),
  });
  return (
    <div className="collab-view">
      <CollabToolbar
        form={form}
        onForm={setForm}
        onDiagnostics={() => {
          setDiagnostics(true);
        }}
      />
      {form === "create" ? (
        <CreateRoomForm
          folder={explorer.rootName}
          onDone={() => {
            setForm(null);
          }}
        />
      ) : null}
      {form === "join" ? (
        <JoinRoomForm
          onDone={() => {
            setForm(null);
          }}
        />
      ) : null}
      {panels.length === 0 && form === null && (snapshot?.rooms.length ?? 0) === 0 ? (
        <p className="collab-view--empty">{t("collab.noRoom")}</p>
      ) : null}
      {panels.map((room) => (
        <div key={room.roomUid}>
          <RoomSection room={room} />
          {room.side === "participant" ? <SharedFiles roomUid={room.roomUid} /> : null}
        </div>
      ))}
      <StoredRooms
        rooms={snapshot?.rooms ?? []}
        active={new Set([...rooms.status.hosting, ...rooms.status.joined])}
      />
      {diagnostics ? (
        <CollabDiagnostics
          onClose={() => {
            setDiagnostics(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Redraws the panel when presence (who is where), the network rooms or a management action changes. */
function useCollabStores(): void {
  const { presence, rooms, manage } = container.collab;
  useSyncExternalStore(
    (l) => presence.subscribeActive(l),
    () => presence.getActiveVersion(),
  );
  useSyncExternalStore(
    (l) => rooms.subscribe(l),
    () => rooms.status,
  );
  useSyncExternalStore(
    (l) => manage.subscribe(l),
    () => manage.getVersion(),
  );
  const voice = container.collab.voice;
  useSyncExternalStore(
    (l) => voice.subscribe(l),
    () => voice.getVersion(),
  );
}

type Form = "create" | "join" | null;

function CollabToolbar({
  form,
  onForm,
  onDiagnostics,
}: {
  form: Form;
  onForm: (form: Form) => void;
  onDiagnostics: () => void;
}) {
  const toggle = (which: "create" | "join") => {
    onForm(form === which ? null : which);
  };
  return (
    <div className="collab-toolbar" role="toolbar" aria-label={t("view.collaboration")}>
      <button
        type="button"
        aria-pressed={form === "create"}
        onClick={() => {
          toggle("create");
        }}
      >
        {t("collab.create.title")}
      </button>
      <button
        type="button"
        aria-pressed={form === "join"}
        onClick={() => {
          toggle("join");
        }}
      >
        {t("collab.join.title")}
      </button>
      <button type="button" onClick={onDiagnostics}>
        {t("collab.diag.button")}
      </button>
    </div>
  );
}
