/** Line endings ignored: `a\r\nb` and `a\nb` are the same text for "did the file change?". */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function sameText(a: string, b: string): boolean {
  return a === b || normalizeEol(a) === normalizeEol(b);
}

export interface TextEdit {
  /** Offset in the old text where the replaced part starts. */
  start: number;
  /** Offset in the old text where it ends. */
  end: number;
  /** What goes there. */
  text: string;
}

/**
 * The smallest single edit that turns `before` into `after`: the common start
 * and common end are kept. Applying just that to an editor leaves the cursor,
 * selections and scroll position outside the changed part where they were.
 * `null` when the texts are identical.
 */
export function minimalEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--;
    endAfter--;
  }
  // Never split a surrogate pair.
  const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
  if (start > 0 && high(before.charCodeAt(start - 1))) start--;
  if (endAfter < after.length && high(after.charCodeAt(endAfter - 1))) {
    endAfter++;
    endBefore++;
  }
  return { start, end: endBefore, text: after.slice(start, endAfter) };
}

/** `path` in one comparable spelling: forward slashes, lower case on Windows-style (drive letter) paths. */
export function pathKey(path: string): string {
  const unified = path.replace(/\\/g, "/");
  return /^[A-Za-z]:/.test(unified) ? unified.toLowerCase() : unified;
}

/** The folder part of a path (either slash style), or "" when there is none. */
export function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? "" : path.slice(0, cut);
}
