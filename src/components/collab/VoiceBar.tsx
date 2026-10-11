import { useSyncExternalStore } from "react";

import { t } from "../../i18n";
import { container } from "../../services/container";
import type { RoomPanel } from "../../services/collab/collabPanelModel";
import type { VoiceView } from "../../services/collab/voice/voiceService";
import { outputSelectable } from "../../services/collab/voice/voiceWiring";
import { HandIcon, MicIcon, MicOffIcon } from "../icons";

/** A voice problem in words (the raw text is never shown here). */
function problemText(view: VoiceView): string | null {
  if (!view.problem) return null;
  const key = `voice.problem.${view.problem}`;
  const text = t(key);
  return text === key ? t("voice.problem.other") : text;
}

function DeviceSelect({
  label,
  value,
  devices,
  onChange,
}: {
  label: string;
  value: string;
  devices: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="collab-voice-bar__device">
      {label}
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t("voice.device.default")}</option>
        {devices.map((d, i) => (
          <option key={d.id} value={d.id}>
            {d.label || t("voice.device.unnamed", { n: String(i + 1) })}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Joined: mute, hand, devices, leave — and what this member may not do right now. */
function InCall({ view, room }: { view: VoiceView; room: RoomPanel }) {
  const voice = container.collab.voice;
  const mine = voice.roster(room.roomUid).find((m) => m.peer === room.you.peer);
  const listenOnly = mine ? !mine.canSpeak : !room.you.permissions.has("voice.speak");
  return (
    <>
      <span className="collab-voice-bar__controls">
        <button
          type="button"
          aria-pressed={!view.muted}
          disabled={view.phase !== "joined" || listenOnly}
          title={listenOnly ? t("voice.listenOnlyReason") : undefined}
          onClick={() => void voice.toggleMute()}
        >
          {view.muted ? <MicOffIcon /> : <MicIcon />}
          {view.muted ? t("voice.unmute") : t("voice.mute")}
        </button>
        <button
          type="button"
          aria-pressed={view.handRaised}
          disabled={view.phase !== "joined"}
          onClick={() => void voice.setHand(!view.handRaised)}
        >
          <HandIcon />
          {view.handRaised ? t("voice.lowerHand") : t("voice.raiseHand")}
        </button>
        <button type="button" onClick={() => void voice.leave()}>
          {t("voice.leave")}
        </button>
      </span>
      {view.phase === "reconnecting" ? (
        <p className="collab-voice-bar__note">{t("voice.reconnecting")}</p>
      ) : voice.modeOf(room.roomUid).mode === "sfu" ? (
        <p className="collab-voice-bar__note">
          {view.audioConnected > 0 ? t("voice.classroomConnected") : t("voice.classroomConnecting")}
        </p>
      ) : view.audioPeers > 0 ? (
        <p className="collab-voice-bar__note">
          {t("voice.audioConnected", {
            connected: String(view.audioConnected),
            total: String(view.audioPeers),
          })}
        </p>
      ) : null}
      {listenOnly && !mine?.forceMuted ? (
        <p className="collab-voice-bar__note">{t("voice.listenOnly")}</p>
      ) : null}
      {mine?.forceMuted ? (
        <p className="collab-voice-bar__note">{t("voice.forceMutedNote")}</p>
      ) : null}
      {view.mic === "ok" ? (
        <DeviceSelect
          label={t("voice.device.microphone")}
          value={view.inputId}
          devices={view.inputs}
          onChange={(id) => void voice.selectInput(id)}
        />
      ) : null}
      {view.mic === "ok" && outputSelectable() && view.outputs.length > 0 ? (
        <DeviceSelect
          label={t("voice.device.speaker")}
          value={view.outputId}
          devices={view.outputs}
          onChange={(id) => {
            voice.selectOutput(id);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The room's voice call in the Collaboration panel (Milestone 24, phase 9): Join Voice (no microphone prompt before it),
 * then mute, raise hand, microphone and speaker, leave. The call never affects the room connection or code editing.
 */
export function VoiceBar({ room }: { room: RoomPanel }) {
  const voice = container.collab.voice;
  useSyncExternalStore(
    (listener) => voice.subscribe(listener),
    () => voice.getVersion(),
  );
  const view = voice.state();
  const here = view.roomUid === room.roomUid && view.phase !== "idle";
  const members = voice.roster(room.roomUid);
  const canJoin = room.you.permissions.has("voice.join");
  const { mode, capacity } = voice.modeOf(room.roomUid);
  const full = !here && members.length >= capacity;
  const fullText = mode === "sfu" ? t("voice.problem.fullClassroom") : t("voice.problem.full");
  const shown = view.roomUid === room.roomUid || view.roomUid === null ? problemText(view) : null;
  // Taken out of the call: say why when it is a missing permission, otherwise just that it happened.
  const problem = view.problem === "removed" && !canJoin ? t("voice.problem.notAllowed") : shown;
  if (room.closed) return null;
  return (
    <div className="collab-voice-bar" role="group" aria-label={t("voice.title")}>
      <span className="collab-voice-bar__title">
        {t("voice.title")}
        <span className="collab-voice-bar__mode">{t(`voice.mode.${mode}`)}</span>
        <span className="collab-voice-bar__count">
          {t("voice.count", { count: members.length })}
        </span>
      </span>
      {here ? (
        <InCall view={view} room={room} />
      ) : (
        <button
          type="button"
          className="collab-button--primary"
          disabled={!canJoin || full || view.phase === "joining"}
          title={
            !canJoin ? t("voice.problem.notAllowed") : full ? fullText : undefined
          }
          onClick={() =>
            void voice.join(room.roomUid, canJoin, room.you.permissions.has("voice.speak"))
          }
        >
          {view.phase === "joining" && view.roomUid === room.roomUid
            ? t("voice.joining")
            : t("voice.join")}
        </button>
      )}
      {problem ? (
        <p className="collab-voice-bar__problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
