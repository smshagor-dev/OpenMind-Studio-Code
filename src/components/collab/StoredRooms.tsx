import { useSyncExternalStore } from "react";

import { t } from "../../i18n";
import { container } from "../../services/container";
import type { CollabRoomView } from "../../services/collab/collabIpc";
import { joinErrorText } from "./collabLabels";

/**
 * Rooms this computer created or joined that aren't on the network now (their history stays): host one again (its
 * folder must be open in this window) or rejoin one.
 */
export function StoredRooms({
  rooms,
  active,
}: {
  rooms: readonly CollabRoomView[];
  active: ReadonlySet<string>;
}) {
  const manage = container.collab.manage;
  useSyncExternalStore(
    (listener) => manage.subscribe(listener),
    () => manage.getVersion(),
  );
  const progress = manage.joinProgress();
  const idle = rooms.filter((r) => !r.closed && !r.archived && !active.has(r.roomUid));
  if (idle.length === 0) return null;
  return (
    <section className="collab-stored" aria-label={t("collab.stored")}>
      <h3 className="collab-subhead">{t("collab.stored")}</h3>
      <ul className="collab-requests">
        {idle.map((room) => (
          <li key={room.roomUid} className="collab-request">
            <span className="collab-request__name" title={room.name}>
              {room.name}
            </span>
            {room.relation === "created" ? (
              <button type="button" onClick={() => void manage.hostAgain(room.roomUid)}>
                {t("collab.hostAgain")}
              </button>
            ) : (
              <button
                type="button"
                disabled={progress.busy}
                onClick={() => void manage.rejoin(room.roomUid)}
              >
                {t("collab.rejoin")}
              </button>
            )}
            {progress.room === room.roomUid && progress.stage ? (
              <span className="collab-request__status" role="status">
                {progress.error
                  ? joinErrorText(progress.error.kind)
                  : t(`collab.join.${progress.stage}`)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
