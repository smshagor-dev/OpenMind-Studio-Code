/**
 * Lays out a commit graph: each commit gets a column (lane), and each row says which lines to draw — from the lanes
 * above into the commit or straight through, and from the commit down to its parents' lanes. Input is newest first
 * with parent ids (Git's own order); pure, so the layout is tested without drawing.
 */

export interface GraphCommit {
  hash: string;
  parents: string[];
}

/** A line inside one row, in lane units: `y` 0 = the row's top, 0.5 = the commit dot, 1 = the bottom. */
export interface GraphSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The lane the line belongs to (for its colour). */
  lane: number;
}

export interface GraphRow {
  hash: string;
  column: number;
  /** How many lanes the row is wide. */
  width: number;
  segments: GraphSegment[];
}

function freeSlot(lanes: (string | null)[]): number {
  const index = lanes.indexOf(null);
  return index >= 0 ? index : lanes.length;
}

export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  let lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const before = lanes.slice();
    let column = before.indexOf(commit.hash);
    if (column < 0) column = freeSlot(before);
    const after = before.slice();
    // Every lane waiting for this commit ends here.
    for (let i = 0; i < after.length; i++) if (after[i] === commit.hash) after[i] = null;
    const [first, ...rest] = commit.parents;
    if (first !== undefined) {
      // The first parent continues in this column; a lane further right already waiting for it joins in here.
      const waiting = after.indexOf(first);
      if (waiting > column) after[waiting] = null;
      after[column] = waiting >= 0 && waiting < column ? null : first;
    } else {
      after[column] = null;
    }
    const parentLanes: number[] = [];
    if (first !== undefined) parentLanes.push(after.indexOf(first));
    for (const parent of rest) {
      let lane = after.indexOf(parent);
      if (lane < 0) {
        lane = freeSlot(after);
        after[lane] = parent;
      }
      parentLanes.push(lane);
    }
    while (after.length > 0 && after[after.length - 1] === null) after.pop();
    const segments: GraphSegment[] = [];
    before.forEach((hash, lane) => {
      if (hash === null) return;
      if (hash === commit.hash) {
        segments.push({ x1: lane, y1: 0, x2: column, y2: 0.5, lane: column });
      } else {
        const below = after.indexOf(hash);
        if (below >= 0) segments.push({ x1: lane, y1: 0, x2: below, y2: 1, lane: below });
      }
    });
    for (const lane of parentLanes) {
      if (lane >= 0) segments.push({ x1: column, y1: 0.5, x2: lane, y2: 1, lane });
    }
    rows.push({
      hash: commit.hash,
      column,
      width: Math.max(before.length, after.length, column + 1),
      segments,
    });
    lanes = after;
  }
  return rows;
}
