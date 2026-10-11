import { useSyncExternalStore } from "react";

import "../../styles/collab.css";

import { t } from "../../i18n";
import { container } from "../../services/container";
import type { Collaborator } from "../../services/collab/presenceService";

/** Dots shown before "+N". */
const MAX_DOTS = 3;

/** A member's initial (the first character as the reader sees it, emoji and accents whole). */
function initial(name: string): string {
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name.trim());
  const first = Array.from(segments, (s) => s.segment)[0];
  return first === undefined ? "?" : first.toLocaleUpperCase();
}

function label(c: Collaborator): string {
  const name = c.name || t("collab.member");
  return c.typing ? t("collab.typingName", { name }) : name;
}

/** Coloured initials of the members in a file. Redraws only when *who is where* changes, never for a cursor move. */
export function CollabDots({ path, folder = false }: { path: string | null; folder?: boolean }) {
  const presence = container.collab.presence;
  useSyncExternalStore(
    (listener) => presence.subscribeActive(listener),
    () => presence.getActiveVersion(),
  );
  if (path === null) return null;
  const people = presence.here(path, folder);
  if (people.length === 0) return null;
  const shown = people.slice(0, MAX_DOTS);
  const more = people.length - shown.length;
  const title = people.map(label).join(", ");
  return (
    <span
      className="collab-dots"
      title={title}
      aria-label={t("collab.hereNamed", { names: title })}
    >
      {shown.map((c) => (
        <span
          key={c.peer}
          aria-hidden="true"
          className={`collab-badge collab-c-${String(c.color)}${c.typing ? " collab-badge--typing" : ""}`}
        >
          {initial(c.name)}
        </span>
      ))}
      {more > 0 ? <span className="collab-dots__more">+{more}</span> : null}
    </span>
  );
}
