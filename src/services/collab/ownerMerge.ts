/**
 * What the Owner's editor and a shared document become when the editor joins the document while it has unsaved edits
 * (Milestone 24 stabilization). Three texts: `base` — what the editor's buffer started from (its saved text, normally
 * the file on disk); `ours` — the editor's text now; `shared` — the shared document (it may hold accepted changes nobody
 * saved yet, e.g. recovered after the Owner's app crashed and restarted).
 *
 * The rule is: **nothing that was typed is lost.** The editor's edits win when the shared document is still the base;
 * the shared document wins when the editor has no edits of its own; both are kept when they changed different places;
 * when they overlap, the shared document stays and the editor's text is kept apart (`conflict`) for the Owner to
 * compare — never silently discarded.
 */
export type OwnerMerge =
  { kind: "keepShared" } | { kind: "useText"; text: string } | { kind: "conflict" };

/** The changed part between two texts: `[start, endA)` in `a` became `[start, endB)` in `b`. */
interface Region {
  start: number;
  endA: number;
  endB: number;
}

function region(a: string, b: string): Region {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let tail = 0;
  while (
    tail < a.length - start &&
    tail < b.length - start &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  return { start, endA: a.length - tail, endB: b.length - tail };
}

export function mergeOwnerText(base: string, ours: string, shared: string): OwnerMerge {
  if (ours === shared || ours === base) return { kind: "keepShared" };
  if (shared === base) return { kind: "useText", text: ours };
  const mine = region(base, ours);
  const theirs = region(base, shared);
  // Strictly apart (touching edits, e.g. two insertions at one place, have no safe order).
  let parts: [Region, string, Region, string];
  if (mine.endA < theirs.start) parts = [mine, ours, theirs, shared];
  else if (theirs.endA < mine.start) parts = [theirs, shared, mine, ours];
  else return { kind: "conflict" };
  const [first, firstText, second, secondText] = parts;
  const text =
    base.slice(0, first.start) +
    firstText.slice(first.start, first.endB) +
    base.slice(first.endA, second.start) +
    secondText.slice(second.start, second.endB) +
    base.slice(second.endA);
  return { kind: "useText", text };
}
