import { useEffect, useSyncExternalStore } from "react";

import { t } from "../../i18n";
import { container } from "../../services/container";
import { ChevronIcon } from "../icons";
import { FileTypeIcon } from "../fileIcons";
import { CollabDots } from "./CollabDots";
import { collabUri } from "../../services/collab/remoteTree";

/**
 * A joined room's shared files (the Owner's tree, phase 5's service): folders expand, a file opens as the room's
 * collaborative document. Nothing is downloaded until a file is opened.
 */
export function SharedFiles({ roomUid }: { roomUid: string }) {
  const remote = container.collab.remote;
  const room = useSyncExternalStore(
    (listener) => remote.subscribe(listener),
    () => remote.room(roomUid),
  );
  const rows = remote.rows(roomUid);
  const ready = room.tree.ready;
  useEffect(() => {
    // A window opened (or reloaded) after the room's tree arrived reads it now; later changes come as events.
    if (!ready) void remote.loadTree(roomUid);
  }, [remote, roomUid, ready]);
  return (
    <section className="collab-files" aria-label={t("collab.files")}>
      <h3 className="collab-subhead">{t("collab.files")}</h3>
      {!room.tree.ready ? <p className="collab-form__note">{t("collab.filesLoading")}</p> : null}
      <ul className="collab-files__list" role="tree">
        {rows.map(({ entry, depth, expanded }) => {
          const folder = entry.kind === "folder";
          const loading = room.loading.get(entry.id);
          return (
            <li key={entry.id} role="treeitem" aria-expanded={folder ? expanded : undefined}>
              <button
                type="button"
                className="collab-files__row"
                style={{ paddingLeft: `${String(8 + depth * 12)}px` }}
                title={entry.path}
                onClick={() => {
                  if (folder) remote.toggle(roomUid, entry.id);
                  else void remote.open(roomUid, entry.id);
                }}
              >
                <span className="collab-files__twistie">
                  {folder ? <ChevronIcon expanded={expanded} /> : null}
                </span>
                {folder ? null : <FileTypeIcon name={entry.name} />}
                <span className="collab-files__name">{entry.name}</span>
                {loading ? (
                  <span className="collab-files__progress">
                    {Math.round((loading.received / Math.max(loading.total, 1)) * 100)}%
                  </span>
                ) : null}
                {folder ? null : <CollabDots path={collabUri(roomUid, entry.id)} />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
