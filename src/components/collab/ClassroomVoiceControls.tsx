import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { t } from "../../i18n";
import { container } from "../../services/container";
import type { RoomPanel } from "../../services/collab/collabPanelModel";
import { errorText } from "../../services/collab/roomIpc";
import {
  tauriClassroomIpc,
  type ClassroomIpc,
  type ClassroomStatus,
} from "../../services/collab/voice/classroomIpc";

type Act = (run: () => Promise<void>) => void;

/** Which media server classroom voice would use now, in words. */
function serverText(status: ClassroomStatus): string {
  if (status.local.running && status.local.bind)
    return t("classroom.server.local", { address: status.local.bind });
  if (status.externalUrl && status.externalHasSecret)
    return t("classroom.server.external", { address: status.externalUrl });
  if (status.externalUrl) return t("classroom.server.noSecret");
  return t("classroom.server.none");
}

/** The media server on this computer: Stop, Start on a chosen address, or where to install it. */
function LocalServer({
  status,
  busy,
  act,
  ipc,
}: {
  status: ClassroomStatus;
  busy: boolean;
  act: Act;
  ipc: ClassroomIpc;
}) {
  const [bind, setBind] = useState("");
  const chosen = bind || status.addresses[0] || "";
  if (status.local.running)
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          act(() => ipc.stopLocal());
        }}
      >
        {t("classroom.stop")}
      </button>
    );
  if (!status.localSupported)
    return <p className="collab-classroom__server">{t("classroom.localUnsupported")}</p>;
  if (!status.installed)
    return (
      <button
        type="button"
        onClick={() => {
          container.run("runtime.manage");
        }}
      >
        {t("classroom.install")}
      </button>
    );
  return (
    <span className="collab-classroom__start">
      <select
        aria-label={t("classroom.address")}
        value={chosen}
        onChange={(event) => {
          setBind(event.target.value);
        }}
      >
        {status.addresses.map((address) => (
          <option key={address} value={address}>
            {address}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          act(() => ipc.startLocal(chosen || null));
        }}
      >
        {t("classroom.start")}
      </button>
    </span>
  );
}

/** The configured server's API secret: typed once, saved encrypted by the backend, never shown again. */
function SecretField({ busy, act, ipc }: { busy: boolean; act: Act; ipc: ClassroomIpc }) {
  const [secret, setSecret] = useState("");
  return (
    <span className="collab-classroom__secret">
      <input
        type="password"
        autoComplete="off"
        aria-label={t("classroom.secret")}
        placeholder={t("classroom.secret")}
        value={secret}
        onChange={(event) => {
          setSecret(event.target.value);
        }}
      />
      <button
        type="button"
        disabled={busy || secret.length === 0}
        onClick={() => {
          const value = secret;
          setSecret("");
          act(() => ipc.setSecret(value));
        }}
      >
        {t("classroom.saveSecret")}
      </button>
    </span>
  );
}

/**
 * The room Owner's classroom voice controls (Milestone 24, phase 11), next to the voice bar of a hosted room: peer to
 * peer or classroom for this room (not while anyone is in the call), the media server on this computer (start/stop on
 * one of its addresses), and the secret of a configured server. Members never see this; their voice bar just says
 * "Classroom".
 */
export function ClassroomVoiceControls({
  room,
  ipc = tauriClassroomIpc,
}: {
  room: RoomPanel;
  ipc?: ClassroomIpc;
}) {
  const voice = container.collab.voice;
  useSyncExternalStore(
    (listener) => voice.subscribe(listener),
    () => voice.getVersion(),
  );
  const [status, setStatus] = useState<ClassroomStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    ipc
      .status()
      .then(setStatus)
      .catch(() => undefined);
  }, [ipc]);
  const { mode } = voice.modeOf(room.roomUid);
  const callSize = voice.roster(room.roomUid).length;
  // Read again when the mode or the call changes (a server stopped or lost shows up with them); never on a timer.
  useEffect(refresh, [refresh, mode, callSize]);
  if (room.side !== "host" || room.closed) return null;
  const act: Act = (run) => {
    setBusy(true);
    setError(null);
    run()
      .catch((err: unknown) => {
        setError(errorText(err));
      })
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };
  return (
    <div className="collab-classroom" role="group" aria-label={t("classroom.title")}>
      <label
        className="collab-classroom__mode"
        title={callSize > 0 ? t("classroom.modeLocked") : undefined}
      >
        <input
          type="checkbox"
          checked={mode === "sfu"}
          disabled={busy || callSize > 0}
          onChange={(event) => {
            act(() => ipc.setMode(room.roomUid, event.target.checked ? "sfu" : "p2p"));
          }}
        />
        {t("classroom.toggle")}
      </label>
      {mode === "sfu" && status ? (
        <>
          <p className="collab-classroom__server">{serverText(status)}</p>
          <LocalServer status={status} busy={busy} act={act} ipc={ipc} />
          {status.externalUrl && !status.local.running ? (
            <SecretField busy={busy} act={act} ipc={ipc} />
          ) : null}
        </>
      ) : null}
      {error ? (
        <p className="collab-voice-bar__problem" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
