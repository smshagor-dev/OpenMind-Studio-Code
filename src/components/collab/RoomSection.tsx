import { useState } from "react";

import { t } from "../../i18n";
import { container } from "../../services/container";
import type {
  MemberAction,
  ParticipantRow,
  RoomPanel,
} from "../../services/collab/collabPanelModel";
import { approvalRoles, approveCommands, RANK } from "../../services/collab/collabPanelModel";
import type { PermissionModel, RoomCommand } from "../../services/collab/roomIpc";
import { ConfirmDialog } from "../ConfirmDialog";
import { ROLE_KEYS } from "./collabLabels";
import { MemberRow } from "./MemberRow";
import { PermissionEditor } from "./PermissionEditor";
import { VoiceBar } from "./VoiceBar";
import { ClassroomVoiceControls } from "./ClassroomVoiceControls";
import { RoomCodeBlock, RoomControls, TransferDialog } from "./RoomControls";

/** A destructive action waiting for its confirmation. */
export interface Pending {
  title: string;
  message: string;
  confirmLabel: string;
  commands: RoomCommand[];
  /** Something to do instead of commands (leaving the room). */
  action?: () => void;
}

function confirmation(action: MemberAction, row: ParticipantRow): Pending | null {
  const name = row.name || t("collab.member");
  const target = row.peer;
  switch (action.kind) {
    case "kick":
      return {
        title: t("collab.confirm.kick.title", { name }),
        message: t("collab.confirm.kick.message", { name }),
        confirmLabel: t("collab.action.kick"),
        commands: [{ command: "kick", target }],
      };
    case "remove":
      return {
        title: t("collab.confirm.remove.title", { name }),
        message: t("collab.confirm.remove.message", { name }),
        confirmLabel: t("collab.action.remove"),
        commands: [{ command: "remove", target }],
      };
    case "ban":
      return {
        title: t("collab.confirm.ban.title", { name }),
        message: t("collab.confirm.ban.message", { name }),
        confirmLabel: t("collab.action.ban"),
        commands: [{ command: "ban", target }],
      };
    default:
      return null;
  }
}

function Group({
  title,
  rows,
  room,
  onAction,
}: {
  title: string;
  rows: ParticipantRow[];
  room: RoomPanel;
  onAction: (r: ParticipantRow, a: MemberAction) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <h3 className="collab-subhead">{title}</h3>
      <ul className="collab-people">
        {rows.map((row) => (
          <MemberRow key={row.peer} room={room} row={row} onAction={onAction} />
        ))}
      </ul>
    </>
  );
}

/** Members waiting for approval: approve as a role the backend lets this member give, or reject. */
function JoinRequests({ room, run }: { room: RoomPanel; run: (c: RoomCommand[]) => void }) {
  const roles = approvalRoles(room);
  if (room.pending.length === 0 || roles.length === 0) return null;
  return (
    <>
      <h3 className="collab-subhead">{t("collab.requests", { count: room.pending.length })}</h3>
      <ul className="collab-requests">
        {room.pending.map((row) => {
          const name = row.name || t("collab.member");
          return (
            <li key={row.peer} className="collab-request">
              <span className="collab-request__name" title={name}>
                {name}
              </span>
              <span className="collab-request__actions">
                {roles.map((role) => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => {
                      run(approveCommands(room, row.peer, role));
                    }}
                  >
                    {t("collab.approveAs", { role: t(ROLE_KEYS[role]) })}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    run([{ command: "denyJoin", target: row.peer }]);
                  }}
                >
                  {t("collab.reject")}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Banned({ room, run }: { room: RoomPanel; run: (c: RoomCommand[]) => void }) {
  if (room.banned.length === 0) return null;
  const canUnban = room.you.permissions.has("member.unban");
  return (
    <>
      <h3 className="collab-subhead">{t("collab.banned")}</h3>
      <ul className="collab-requests">
        {room.banned.map((row) => (
          <li key={row.peer} className="collab-request">
            <span className="collab-request__name">{row.name || t("collab.member")}</span>
            {canUnban && RANK[room.you.role] > RANK[row.role] ? (
              <button
                type="button"
                onClick={() => {
                  run([{ command: "unban", target: row.peer }]);
                }}
              >
                {t("collab.unban")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/** One room: its state and Room Code, controls, join requests, members by role, banned members. */
const GROUP_KEYS = {
  owner: "collab.role.owner",
  admin: "collab.group.admins",
  editor: "collab.group.editors",
  viewer: "collab.group.viewers",
} as const;

/** A confirmation for a destructive action; the commands (or the action) run only on Confirm. */
function PendingDialog({
  pending,
  onDone,
  run,
}: {
  pending: Pending;
  onDone: () => void;
  run: (commands: RoomCommand[]) => void;
}) {
  return (
    <ConfirmDialog
      title={pending.title}
      message={pending.message}
      confirmLabel={pending.confirmLabel}
      cancelLabel={t("common.cancel")}
      onCancel={onDone}
      onConfirm={() => {
        onDone();
        if (pending.action) pending.action();
        else run(pending.commands);
      }}
    />
  );
}

export function RoomSection({ room }: { room: RoomPanel }) {
  const manage = container.collab.manage;
  const [pending, setPending] = useState<Pending | null>(null);
  const [transfer, setTransfer] = useState<ParticipantRow | null>(null);
  const [editing, setEditing] = useState<{ peer: string; model: PermissionModel } | null>(null);
  const run = (commands: RoomCommand[]) => void manage.run(room.roomUid, commands);
  const onAction = (row: ParticipantRow, action: MemberAction) => {
    if (action.kind === "role") void manage.setRole(room.roomUid, row.peer, action.role);
    else if (action.kind === "transfer") setTransfer(row);
    else if (action.kind === "forceMute")
      run([{ command: "forceMute", target: row.peer, muted: action.muted }]);
    else if (action.kind === "permissions")
      void manage.permissionModel().then((model) => {
        setEditing({ peer: row.peer, model });
      });
    else setPending(confirmation(action, row));
  };
  const byRole = (role: ParticipantRow["role"]) => room.participants.filter((p) => p.role === role);
  const editRow = editing ? room.participants.find((p) => p.peer === editing.peer) : undefined;
  return (
    <section
      className="collab-room"
      aria-label={room.name || t("collab.room")}
      aria-busy={manage.isBusy(room.roomUid)}
    >
      <RoomControls room={room} onConfirm={setPending} />
      <VoiceBar room={room} />
      <ClassroomVoiceControls room={room} />
      {room.side === "host" ? <RoomCodeBlock room={room} onConfirm={setPending} /> : null}
      <JoinRequests room={room} run={run} />
      {(["owner", "admin", "editor", "viewer"] as const).map((role) => (
        <Group
          key={role}
          title={t(GROUP_KEYS[role])}
          rows={byRole(role)}
          room={room}
          onAction={onAction}
        />
      ))}
      <Banned room={room} run={run} />
      {pending ? (
        <PendingDialog
          pending={pending}
          onDone={() => {
            setPending(null);
          }}
          run={run}
        />
      ) : null}
      {transfer ? (
        <TransferDialog
          row={transfer}
          onCancel={() => {
            setTransfer(null);
          }}
          onConfirm={() => {
            setTransfer(null);
            run([{ command: "transferOwnership", target: transfer.peer }]);
          }}
        />
      ) : null}
      {editing && editRow ? (
        <PermissionEditor
          key={`${editRow.granted?.join() ?? ""}|${editRow.denied?.join() ?? ""}`}
          row={editRow}
          model={editing.model}
          grantable={room.you.permissions}
          onClose={() => {
            setEditing(null);
          }}
          onSave={(overrides) =>
            manage.run(room.roomUid, [{ command: "setOverrides", target: editRow.peer, overrides }])
          }
        />
      ) : null}
    </section>
  );
}
