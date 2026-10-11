import { useState } from "react";

import { t } from "../../i18n";
import type {
  MemberAction,
  ParticipantRow,
  RoomPanel,
} from "../../services/collab/collabPanelModel";
import { memberActions } from "../../services/collab/collabPanelModel";
import { EllipsisIcon, HandIcon, MicIcon, MicOffIcon } from "../icons";
import { MenuPopup, type PopupItem } from "../MenuPopup";
import { ROLE_KEYS } from "./collabLabels";

const CONNECTION_KEYS = {
  online: "collab.status.online",
  reconnecting: "collab.status.reconnecting",
  offline: "collab.status.offline",
} as const;

function actionLabel(action: MemberAction): string {
  switch (action.kind) {
    case "role":
      return t("collab.action.makeRole", { role: t(ROLE_KEYS[action.role]) });
    case "permissions":
      return t("collab.action.permissions");
    case "transfer":
      return t("collab.action.transfer");
    case "kick":
      return t("collab.action.kick");
    case "remove":
      return t("collab.action.remove");
    case "ban":
      return t("collab.action.ban");
    case "forceMute":
      return action.muted ? t("voice.action.forceMute") : t("voice.action.allowSpeaking");
  }
}

function menuItems(actions: MemberAction[], onAction: (a: MemberAction) => void): PopupItem[] {
  const item = (a: MemberAction): PopupItem => ({
    kind: "item",
    label: actionLabel(a),
    enabled: true,
    danger:
      a.kind === "kick" ||
      a.kind === "remove" ||
      a.kind === "ban" ||
      a.kind === "transfer" ||
      (a.kind === "forceMute" && a.muted),
    onSelect: () => {
      onAction(a);
    },
  });
  const roles = actions.filter((a) => a.kind === "role");
  const rest = actions.filter((a) => a.kind !== "role");
  const moderation = rest.filter((a) => a.kind !== "permissions");
  return [
    ...roles.map(item),
    ...(roles.length > 0 && rest.length > 0 ? [{ kind: "separator" } as const] : []),
    ...rest.filter((a) => a.kind === "permissions").map(item),
    ...(moderation.length > 0 && rest.length > moderation.length
      ? [{ kind: "separator" } as const]
      : []),
    ...moderation.map(item),
  ];
}

/**
 * One member: name, role, connection, active file and typing; a management menu only for someone this member may
 * act on (the Owner decides each action anyway).
 */
export function MemberRow({
  room,
  row,
  onAction,
}: {
  room: RoomPanel;
  row: ParticipantRow;
  onAction: (row: ParticipantRow, action: MemberAction) => void;
}) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const name = row.name || t("collab.member");
  const actions = memberActions(room, row);
  return (
    <li
      className={`collab-person collab-person--${row.connection}${row.voice?.speaking ? " collab-person--speaking" : ""}`}
    >
      <span className={`collab-dot collab-c-${String(row.color)}`} aria-hidden="true" />
      <span className="collab-person__name" title={name}>
        {row.you ? t("collab.you", { name }) : name}
      </span>
      <span className="collab-person__role">{t(ROLE_KEYS[row.role])}</span>
      <span className="collab-person__status">{t(CONNECTION_KEYS[row.connection])}</span>
      <VoiceBadges row={row} />
      <span className="collab-person__file" title={row.activeFile ?? undefined}>
        {row.activeFile ?? ""}
        {row.typing ? ` ${t("collab.typing")}` : ""}
      </span>
      {actions.length > 0 ? (
        <button
          type="button"
          className="collab-person__menu"
          aria-label={t("collab.manageNamed", { name })}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={(event) => {
            setMenu(event.currentTarget.getBoundingClientRect());
          }}
        >
          <EllipsisIcon />
        </button>
      ) : null}
      {menu ? (
        <MenuPopup
          items={menuItems(actions, (action) => {
            onAction(row, action);
          })}
          x={menu.left}
          y={menu.bottom}
          autoFocus
          ariaLabel={t("collab.manageNamed", { name })}
          onClose={() => {
            setMenu(null);
          }}
        />
      ) : null}
    </li>
  );
}

/** A call member's voice state: microphone or muted (and why), speaking, raised hand. Words for screen readers too. */
function VoiceBadges({ row }: { row: ParticipantRow }) {
  const v = row.voice;
  if (!v) return null;
  const state = v.forceMuted
    ? t("voice.state.forceMuted")
    : !v.canSpeak
      ? t("voice.state.listenOnly")
      : v.muted
        ? t("voice.state.muted")
        : v.speaking
          ? t("voice.state.speaking")
          : t("voice.state.unmuted");
  const label = v.handRaised ? `${state}, ${t("voice.state.hand")}` : state;
  return (
    <span className="collab-voice" role="img" aria-label={label} title={label}>
      {v.muted || !v.canSpeak ? (
        <MicOffIcon className="collab-voice__icon collab-voice__icon--off" />
      ) : (
        <MicIcon
          className={`collab-voice__icon${v.speaking ? " collab-voice__icon--speaking" : ""}`}
        />
      )}
      {v.handRaised ? <HandIcon className="collab-voice__icon collab-voice__hand" /> : null}
    </span>
  );
}
