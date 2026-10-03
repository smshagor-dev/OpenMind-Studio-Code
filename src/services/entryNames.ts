/**
 * The rules for a file or folder name typed in the Explorer, checked while the user types so the name box can say what
 * is wrong before anything is sent. They mirror `openmind_fs::names` in Rust, which checks them again before touching
 * the disk (that check is the one that counts).
 */

const RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/* eslint-disable no-control-regex -- control characters are exactly what file names can't contain */
const FORBIDDEN = /[<>:"|?*\u0000-\u001f]/;
/* eslint-enable no-control-regex */

function segmentProblem(segment: string): string | null {
  if (segment === "") return "A file or folder name must be provided.";
  if (segment === "." || segment === "..") return `"${segment}" is not a valid file or folder name.`;
  const bad = FORBIDDEN.exec(segment);
  if (bad) {
    const shown = bad[0] < " " ? "a control character" : `"${bad[0]}"`;
    return `The name "${segment}" contains ${shown}, which file names can't contain.`;
  }
  if (segment.endsWith(".") || segment.endsWith(" ")) return `The name "${segment}" can't end with a dot or a space.`;
  const stem = (segment.split(".")[0] ?? segment).trimEnd().toUpperCase();
  if (RESERVED.has(stem)) return `"${segment}" is reserved by Windows and can't be used as a name.`;
  if (segment.length > 255) return "The name is too long.";
  return null;
}

export interface NameCheck {
  /** A new entry may name sub-folders (`src/app.ts`); a rename may not. */
  nested: boolean;
  /** The names already in the folder. */
  siblings: readonly string[];
  /** The entry's own current name (a rename to the same name, or only its case, is not a clash). */
  current?: string;
}

/** Why `name` can't be used, or `null` when it can. */
export function entryNameProblem(name: string, check: NameCheck): string | null {
  if (name === "") return "A file or folder name must be provided.";
  const segments = name.split(/[\\/]/);
  if (!check.nested && segments.length > 1) return 'A name can\'t contain "/" or "\\".';
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem !== null) return problem;
  }
  const first = (segments[0] ?? name).toLowerCase();
  const own = check.current?.toLowerCase();
  if (first !== own && check.siblings.some((sibling) => sibling.toLowerCase() === first)) {
    return segments.length > 1
      ? null // an existing folder is reused for the sub-path; the backend refuses a clash at the end
      : `A file or folder "${name}" already exists here. Choose a different name.`;
  }
  return null;
}
