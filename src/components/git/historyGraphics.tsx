import type { GraphRow } from "../../services/git/commitGraph";
import type { FileCommit } from "../../services/git/fileGitIpc";

const LANE = 14;
const ROW = 26;
/** Lane colours: the theme's own accent tokens, repeated. */
const LANE_COLOURS = [
  "var(--collab-1)",
  "var(--collab-2)",
  "var(--collab-3)",
  "var(--collab-4)",
  "var(--collab-5)",
  "var(--collab-6)",
  "var(--collab-7)",
  "var(--collab-8)",
];

function colour(lane: number): string {
  return LANE_COLOURS[lane % LANE_COLOURS.length] ?? "var(--fg-muted)";
}

/** One row's part of the commit graph: lines in and out of the commit's dot. */
export function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const x = (lane: number) => lane * LANE + LANE / 2;
  const y = (part: number) => part * ROW;
  return (
    <svg
      className="file-history__graph"
      width={Math.max(1, width) * LANE}
      height={ROW}
      aria-hidden="true"
    >
      {row.segments.map((segment, index) => (
        <path
          key={index}
          className="git-graph__line"
          stroke={colour(segment.lane)}
          d={`M ${String(x(segment.x1))} ${String(y(segment.y1))} C ${String(x(segment.x1))} ${String(y((segment.y1 + segment.y2) / 2))}, ${String(x(segment.x2))} ${String(y((segment.y1 + segment.y2) / 2))}, ${String(x(segment.x2))} ${String(y(segment.y2))}`}
        />
      ))}
      <circle
        className="git-graph__dot"
        cx={x(row.column)}
        cy={ROW / 2}
        r={4.5}
        fill={colour(row.column)}
      />
    </svg>
  );
}

const PAD_LEFT = 140;
const PAD_TOP = 24;
const AUTHOR_ROW = 34;
const DOT_ROOM = 18;

/**
 * Visual File History: every commit of the loaded history on a time axis, one row per author, the dot's size by the
 * lines it changed in the file. Clicking a dot selects the commit.
 */
export function Timeline({
  commits,
  selected,
  onSelect,
  width,
  label,
}: {
  commits: FileCommit[];
  selected: string | null;
  onSelect: (hash: string) => void;
  width: number;
  label: (commit: FileCommit) => string;
}) {
  if (commits.length === 0) return null;
  const authors = [...new Set(commits.map((commit) => commit.author))];
  const times = commits.map((commit) => commit.authorTime);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = Math.max(1, max - min);
  const plot = Math.max(200, width - PAD_LEFT - 24);
  const height = PAD_TOP + authors.length * AUTHOR_ROW + 24;
  // Room for the largest dot between the author names and the first commit.
  const xOf = (time: number) => PAD_LEFT + DOT_ROOM + ((time - min) / span) * (plot - DOT_ROOM);
  const ticks = [min, min + span / 2, max];
  return (
    <svg width={PAD_LEFT + plot + 24} height={height} role="list">
      {ticks.map((time) => (
        <text key={time} className="git-timeline__label" x={xOf(time)} y={14} textAnchor="middle">
          {new Date(time * 1000).toLocaleDateString()}
        </text>
      ))}
      {authors.map((author, index) => {
        const y = PAD_TOP + index * AUTHOR_ROW + AUTHOR_ROW / 2;
        return (
          <g key={author}>
            <line className="git-timeline__axis" x1={PAD_LEFT} x2={PAD_LEFT + plot} y1={y} y2={y} />
            <text className="git-timeline__label" x={PAD_LEFT - 8} y={y + 4} textAnchor="end">
              {author.length > 20 ? `${author.slice(0, 19)}…` : author}
            </text>
          </g>
        );
      })}
      {commits.map((commit) => {
        const lines = (commit.additions ?? 0) + (commit.deletions ?? 0);
        const radius = Math.min(14, 4 + Math.sqrt(lines));
        const y = PAD_TOP + authors.indexOf(commit.author) * AUTHOR_ROW + AUTHOR_ROW / 2;
        return (
          <circle
            key={commit.hash}
            className="git-timeline__dot"
            role="listitem"
            aria-selected={commit.hash === selected}
            aria-label={label(commit)}
            cx={xOf(commit.authorTime)}
            cy={y}
            r={radius}
            onClick={() => {
              onSelect(commit.hash);
            }}
          >
            <title>{label(commit)}</title>
          </circle>
        );
      })}
    </svg>
  );
}
