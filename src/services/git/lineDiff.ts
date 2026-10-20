/**
 * A line diff of two texts (Myers' algorithm on line ids, after trimming the common start and end), grouped into
 * the changes an editor gutter shows: lines added, lines modified, and places where lines were deleted. Pure, so the
 * File Changes annotation and the line-change commands are tested without an editor.
 */

export type LineChangeKind = "added" | "modified" | "deleted";

/** One change. Line numbers are 1-based; `end` is inclusive. A deletion has `start === end` = the line after it. */
export interface LineChange {
  kind: LineChangeKind;
  /** Lines in the new text. For a deletion: the line the deleted lines were above (`newLineCount + 1` at the end). */
  start: number;
  end: number;
  /** Lines in the old text the change replaced or removed (`originalEnd < originalStart`: none). */
  originalStart: number;
  originalEnd: number;
}

/** Past this many edits the diff is abandoned (a rewrite): the result is `null`, not something slow or wrong. */
export const MAX_EDIT_DISTANCE = 4000;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  // A final line break doesn't start another line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Edit script between `a` and `b` as `"=" | "-" | "+"` steps, or `null` when it would be longer than the limit. */
function myers(a: number[], b: number[]): ("=" | "-" | "+")[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
  }
  if (found < 0) return null;
  const steps: ("=" | "-" | "+")[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d] ?? new Int32Array(0);
    const k = x - y;
    const down = k === -d || (k !== d && (prev[offset + k - 1] ?? 0) < (prev[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push("=");
      x--;
      y--;
    }
    steps.push(down ? "+" : "-");
    if (down) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    steps.push("=");
    x--;
    y--;
  }
  return steps.reverse();
}

/** The changes from `original` to `modified`, in order; `null` when the texts differ too much to diff. */
export function diffLines(original: string, modified: string): LineChange[] | null {
  const a = splitLines(original);
  const b = splitLines(modified);
  const ids = new Map<string, number>();
  const id = (line: string) => {
    let value = ids.get(line);
    if (value === undefined) {
      value = ids.size;
      ids.set(line, value);
    }
    return value;
  };
  const ai = a.map(id);
  const bi = b.map(id);
  let head = 0;
  while (head < ai.length && head < bi.length && ai[head] === bi[head]) head++;
  let tail = 0;
  while (
    tail < ai.length - head &&
    tail < bi.length - head &&
    ai[ai.length - 1 - tail] === bi[bi.length - 1 - tail]
  ) {
    tail++;
  }
  const steps = myers(ai.slice(head, ai.length - tail), bi.slice(head, bi.length - tail));
  if (steps === null) return null;
  return group(steps, head);
}

function group(steps: ("=" | "-" | "+")[], head: number): LineChange[] {
  const changes: LineChange[] = [];
  let oldLine = head + 1;
  let newLine = head + 1;
  let i = 0;
  while (i < steps.length) {
    if (steps[i] === "=") {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    let removed = 0;
    let added = 0;
    while (i < steps.length && steps[i] !== "=") {
      if (steps[i] === "-") removed++;
      else added++;
      i++;
    }
    const originalStart = oldLine;
    const originalEnd = oldLine + removed - 1;
    if (added === 0) {
      changes.push({ kind: "deleted", start: newLine, end: newLine, originalStart, originalEnd });
    } else {
      changes.push({
        kind: removed === 0 ? "added" : "modified",
        start: newLine,
        end: newLine + added - 1,
        originalStart,
        originalEnd,
      });
    }
    oldLine += removed;
    newLine += added;
  }
  return changes;
}

/** The change covering `line` of the new text (a deletion counts for the line below it), or `null`. */
export function changeAt(changes: LineChange[], line: number): LineChange | null {
  return changes.find((change) => line >= change.start && line <= change.end) ?? null;
}

/** Where `line` of the new text was in the old text (`null`: the line is new). */
export function originalLineOf(changes: LineChange[], line: number): number | null {
  let shift = 0;
  for (const change of changes) {
    if (change.kind !== "deleted" && line >= change.start && line <= change.end) return null;
    // A deletion at `line` removed lines above it: they still shift it.
    if (change.start > line) break;
    const removed = change.originalEnd - change.originalStart + 1;
    const added = change.kind === "deleted" ? 0 : change.end - change.start + 1;
    shift += removed - added;
  }
  return line + shift;
}
