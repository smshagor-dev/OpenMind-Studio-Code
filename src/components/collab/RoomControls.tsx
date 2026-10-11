import { useState, useSyncExternalStore } from "react";

import { t } from "../../i18n";
import { container } from "../../services/container";
import type { ParticipantRow, RoomPanel } from "../../services/collab/collabPanelModel";
import { routeLabel } from "../../services/collab/lanStatus";
import type { Pending } from "./RoomSection";

function statusKey(room: RoomPanel): string {
  if (room.closed) return "collab.state.closed";
  if (room.side === "host") return "collab.state.hosting";
  if (room.state === "reconnecting" || room.state === "connecting")
    return "collab.state.reconnecting";
  if (room.state === "connected") return "collab.state.connected";
  return "collab.state.offline";
}

/** The room's name, state and route, and the controls this member's permissions allow. */
export function RoomControls({
  room,
  onConfirm,
}: {
  room: RoomPanel;
  onConfirm: (p: Pending) => void;
}) {
  const manage = container.collab.manage;
  const can = (p: string) => room.you.permissions.has(p) && !room.closed;
  const run = (locked: boolean) =>
    void manage.run(room.roomUid, [{ command: "setLocked", locked }]);
  return (
    <header className="collab-room__header">
      <span className="collab-room__name">{room.name || t("collab.room")}</span>
      <span className="collab-room__chips">
        <span className="collab-chip">{t(statusKey(room))}</span>
        {room.route ? (
          <span className="collab-chip" title={routeLabel(room.route)}>
            {t(`collab.route.${room.route}`)}
          </span>
        ) : null}
        {room.locked ? (
          <span className="collab-chip collab-chip--warn">{t("collab.state.locked")}</span>
        ) : null}
      </span>
      <span className="collab-room__controls">
        {can("room.lock") ? (
          <button
            type="button"
            onClick={() => {
              run(!room.locked);
            }}
          >
            {room.locked ? t("collab.unlock") : t("collab.lock")}
          </button>
        ) : null}
        {can("room.manage") ? (
          <label className="collab-check">
            <input
              type="checkbox"
              checked={room.approvalRequired}
              onChange={(event) => {
                void manage.run(room.roomUid, [
                  { command: "setApproval", required: event.target.checked },
                ]);
              }}
            />
            {t("collab.requireApproval")}
          </label>
        ) : null}
        <CloseOrLeave room={room} canClose={can("room.close")} onConfirm={onConfirm} />
      </span>
    </header>
  );
}

/** Close Room (with `room.close`) and, on a participant's computer, Leave Room — both after a confirmation. */
function CloseOrLeave({
  room,
  canClose,
  onConfirm,
}: {
  room: RoomPanel;
  canClose: boolean;
  onConfirm: (p: Pending) => void;
}) {
  const manage = container.collab.manage;
  const close = () => {
    onConfirm({
      title: t("collab.confirm.close.title"),
      message: t("collab.confirm.close.message"),
      confirmLabel: t("collab.closeRoom"),
      commands: [{ command: "closeRoom" }],
    });
  };
  const leave = () => {
    onConfirm({
      title: t("collab.confirm.leave.title"),
      message: t("collab.confirm.leave.message"),
      confirmLabel: t("collab.leave"),
      commands: [],
      action: () => void manage.leave(room.roomUid),
    });
  };
  return (
    <>
      {canClose ? (
        <button type="button" className="collab-button--danger" onClick={close}>
          {t("collab.closeRoom")}
        </button>
      ) : null}
      {room.side === "participant" ? (
        <button type="button" onClick={leave}>
          {t("collab.leave")}
        </button>
      ) : null}
    </>
  );
}

/** The Room Code, treated as a credential: hidden until revealed, copyable, rotatable after a confirmation. */
export function RoomCodeBlock({
  room,
  onConfirm,
}: {
  room: RoomPanel;
  onConfirm: (p: Pending) => void;
}) {
  const manage = container.collab.manage;
  useSyncExternalStore(
    (l) => manage.subscribe(l),
    () => manage.getVersion(),
  );
  const code = manage.code(room.roomUid);
  if (room.closed) return null;
  return (
    <div className="collab-code" role="group" aria-label={t("collab.code.title")}>
      <span className="collab-code__label">{t("collab.code.title")}</span>
      <code className="collab-code__value" aria-live="polite">
        {code ?? t("collab.code.hidden")}
      </code>
      <span className="collab-code__actions">
        <button
          type="button"
          aria-pressed={code !== null}
          onClick={() => {
            if (code === null) void manage.reveal(room.roomUid);
            else manage.hide(room.roomUid);
          }}
        >
          {code === null ? t("collab.code.reveal") : t("collab.code.hide")}
        </button>
        <button type="button" onClick={() => void manage.copyCode(room.roomUid)}>
          {t("collab.code.copy")}
        </button>
        {room.you.permissions.has("room.rotateInvite") ? (
          <button
            type="button"
            onClick={() => {
              onConfirm({
                title: t("collab.confirm.rotate.title"),
                message: t("collab.confirm.rotate.message"),
                confirmLabel: t("collab.code.rotate"),
                commands: [{ command: "rotateInvite" }],
              });
            }}
          >
            {t("collab.code.rotate")}
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** Ownership transfer: the member's name must be typed to confirm; hosting stays on this computer. */
export function TransferDialog({
  row,
  onConfirm,
  onCancel,
}: {
  row: ParticipantRow;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const name = row.name || t("collab.member");
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === name.trim();
  return (
    <div className="modal-overlay" role="presentation">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="collab-transfer-title"
      >
        <h2 id="collab-transfer-title">{t("collab.confirm.transfer.title", { name })}</h2>
        <p>{t("collab.confirm.transfer.message", { name })}</p>
        <p>{t("collab.confirm.transfer.hosting")}</p>
        <label className="collab-form__label">
          {t("collab.confirm.transfer.type", { name })}
          <input
            value={typed}
            autoFocus
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </label>
        <div className="modal__actions">
          <button
            type="button"
            className="modal__confirm--danger"
            disabled={!matches}
            onClick={onConfirm}
          >
            {t("collab.action.transfer")}
          </button>
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
