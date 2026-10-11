import { useState, useSyncExternalStore } from "react";

import { t } from "../../i18n";
import { container } from "../../services/container";
import { lanAddressProblem } from "../../services/collab/collabPanelModel";
import type { JoinError, JoinStage } from "../../services/collab/roomIpc";
import { joinErrorText } from "./collabLabels";

const STAGE_KEYS = {
  searching: "collab.join.searching",
  connecting: "collab.join.connecting",
  pending: "collab.join.pending",
  connected: "collab.join.connected",
  failed: "collab.join.failed",
} as const;

/** Create Room: a name; the room shares this window's open folder and its Room Code is shown afterwards. */
export function CreateRoomForm({ folder, onDone }: { folder: string | null; onDone: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  if (folder === null) {
    return (
      <div className="collab-form" role="group" aria-label={t("collab.create.title")}>
        <p className="collab-form__note">{t("collab.create.noFolder")}</p>
        <button type="button" onClick={onDone}>
          {t("common.cancel")}
        </button>
      </div>
    );
  }
  const submit = async () => {
    setBusy(true);
    const room = await container.collab.manage.create(name);
    setBusy(false);
    if (room !== null) onDone();
  };
  return (
    <form
      className="collab-form"
      aria-label={t("collab.create.title")}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="collab-form__label">
        {t("collab.create.name")}
        <input
          value={name}
          maxLength={80}
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <p className="collab-form__note">{t("collab.create.folder", { folder })}</p>
      <div className="collab-form__actions">
        <button
          type="submit"
          className="collab-button--primary"
          disabled={busy || name.trim() === ""}
        >
          {t("collab.create.submit")}
        </button>
        <button type="button" onClick={onDone} disabled={busy}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

/** Join Room: the Room Code; the Owner's local address only as an advanced fallback. */
export function JoinRoomForm({ onDone }: { onDone: () => void }) {
  const manage = container.collab.manage;
  useSyncExternalStore(
    (listener) => manage.subscribe(listener),
    () => manage.getVersion(),
  );
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const progress = manage.joinProgress();
  const problem = lanAddressProblem(address);
  const submit = async () => {
    const error = await manage.joinRoom(code, address);
    if (error === null) {
      manage.resetJoin();
      onDone();
    }
  };
  return (
    <form
      className="collab-form"
      aria-label={t("collab.join.title")}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="collab-form__label">
        {t("collab.join.code")}
        <input
          value={code}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          type="password"
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
      </label>
      <LanAddressField value={address} problem={problem} onChange={setAddress} />
      <JoinStatus stage={progress.stage} error={progress.error} />
      <div className="collab-form__actions">
        <button
          type="submit"
          className="collab-button--primary"
          disabled={progress.busy || code.trim() === "" || problem !== null}
        >
          {t("collab.join.submit")}
        </button>
        <button
          type="button"
          disabled={progress.busy}
          onClick={() => {
            manage.resetJoin();
            onDone();
          }}
        >
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

/** The Owner's local address: hidden behind "advanced", only for networks where the room isn't found by itself. */
function LanAddressField({
  value,
  problem,
  onChange,
}: {
  value: string;
  problem: "format" | "port" | null;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(value !== "");
  return (
    <>
      <button
        type="button"
        className="collab-link"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {t("collab.join.advanced")}
      </button>
      {open ? (
        <label className="collab-form__label">
          {t("collab.join.lanAddress")}
          <input
            value={value}
            placeholder="192.168.1.20:47732"
            aria-invalid={problem !== null}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          <span className="collab-form__note">
            {problem ? t(`collab.join.address.${problem}`) : t("collab.join.lanHint")}
          </span>
        </label>
      ) : null}
    </>
  );
}

/** How the join is going; a failure in words, the backend's own sentence under Details. */
export function JoinStatus({ stage, error }: { stage: JoinStage | null; error: JoinError | null }) {
  const [details, setDetails] = useState(false);
  if (!stage) return null;
  return (
    <>
      <p className="collab-form__progress" role="status">
        {error ? joinErrorText(error.kind) : t(STAGE_KEYS[stage])}
      </p>
      {error ? (
        <button
          type="button"
          className="collab-link"
          aria-expanded={details}
          onClick={() => {
            setDetails(!details);
          }}
        >
          {t("collab.details")}
        </button>
      ) : null}
      {details && error ? <p className="collab-form__details">{error.message}</p> : null}
    </>
  );
}
