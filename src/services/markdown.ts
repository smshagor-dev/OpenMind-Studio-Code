/**
 * A small, safe Markdown parser. It produces a plain data tree that React
 * renders as elements — there is no HTML string anywhere, so nothing in a
 * document can inject markup or run a script: raw HTML in the source is just
 * shown as text, and link targets are checked by `safeHref`.
 *
 * Supported: ATX headings, paragraphs, fenced code, block quotes, bulleted /
 * numbered / task lists (with nesting by indentation), horizontal rules,
 * tables, and inline code, bold, italic, strikethrough, links, autolinks and
 * images (shown as their alt text — the preview never loads anything).
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "em"; c: Inline[] }
  | { t: "strong"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; alt: string }
  | { t: "br" };

export interface ListItem {
  /** `null` for a normal item, `true`/`false` for a `[x]` / `[ ]` task item. */
  checked: boolean | null;
  blocks: Block[];
}

export type Block =
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "paragraph"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "hr" }
  | {
      t: "table";
      head: Inline[][];
      rows: Inline[][][];
      align: ("left" | "center" | "right" | null)[];
    };

const MAX_NESTING = 8;

/** Targets a preview link may point at; anything else renders as plain text. */
export type SafeHref =
  { kind: "web"; url: string } | { kind: "file"; path: string } | { kind: "anchor"; id: string };

/**
 * Classifies a link target. Only `http(s)` addresses, in-page anchors and
 * relative file paths are ever followed; `javascript:`, `data:`, `file:` and
 * every other scheme (and protocol-relative `//host`) are refused.
 */
export function safeHref(raw: string): SafeHref | null {
  const href = raw.trim();
  if (href === "" || hasControlChar(href)) return null;
  if (href.startsWith("#")) return { kind: "anchor", id: href.slice(1) };
  if (href.startsWith("//")) return null;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (scheme) {
    const name = (scheme[1] ?? "").toLowerCase();
    return name === "http" || name === "https" ? { kind: "web", url: href } : null;
  }
  // A relative path (no scheme): drop any #fragment / ?query, decode %20.
  const path = href.split(/[?#]/)[0] ?? "";
  if (path === "" || path.startsWith("/") || path.startsWith("\\")) return null;
  try {
    return { kind: "file", path: decodeURIComponent(path) };
  } catch {
    return null;
  }
}

function hasControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 0x20) return true;
  }
  return false;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines, 0);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const consumed = parseOneBlock(lines, index, depth, blocks);
    index = consumed;
  }
  return blocks;
}

/** Parses the block starting at `start`, pushes it, returns the next line index. */
function parseOneBlock(lines: string[], start: number, depth: number, out: Block[]): number {
  const line = lines[start] ?? "";
  const fence = FENCE.exec(line);
  if (fence) return parseFence(lines, start, fence, out);
  const heading = HEADING.exec(line);
  if (heading) {
    out.push({ t: "heading", level: (heading[1] ?? "#").length, c: parseInline(heading[2] ?? "") });
    return start + 1;
  }
  if (HR.test(line)) {
    out.push({ t: "hr" });
    return start + 1;
  }
  if (QUOTE.test(line) && depth < MAX_NESTING) return parseQuote(lines, start, depth, out);
  if (LIST_ITEM.test(line) && depth < MAX_NESTING) return parseList(lines, start, depth, out);
  if (line.includes("|") && TABLE_SEPARATOR.test(lines[start + 1] ?? "")) {
    return parseTable(lines, start, out);
  }
  return parseParagraph(lines, start, out);
}

function parseFence(lines: string[], start: number, fence: RegExpExecArray, out: Block[]): number {
  const marker = fence[1] ?? "```";
  const body: string[] = [];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().startsWith(marker) && line.trim().replace(/[`~]/g, "") === "") {
      index += 1;
      break;
    }
    body.push(line);
    index += 1;
  }
  out.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
  return index;
}

function parseQuote(lines: string[], start: number, depth: number, out: Block[]): number {
  const inner: string[] = [];
  let index = start;
  while (index < lines.length) {
    const match = QUOTE.exec(lines[index] ?? "");
    if (!match) break;
    inner.push(match[1] ?? "");
    index += 1;
  }
  out.push({ t: "quote", c: parseBlocks(inner, depth + 1) });
  return index;
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

function parseList(lines: string[], start: number, depth: number, out: Block[]): number {
  const first = LIST_ITEM.exec(lines[start] ?? "");
  const baseIndent = indentOf(first?.[1] ?? "");
  const ordered = /\d/.test(first?.[2] ?? "");
  const items: ListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index] ?? "");
    if (
      !match ||
      indentOf(match[1] ?? "") !== baseIndent ||
      /\d/.test(match[2] ?? "") !== ordered
    ) {
      break;
    }
    const itemLines = [match[3] ?? ""];
    index += 1;
    // Continuation: deeper-indented lines (nested lists, wrapped text) belong to this item.
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() === "") {
        const after = lines[index + 1] ?? "";
        if (after.trim() !== "" && indentOf(after) > baseIndent) {
          itemLines.push("");
          index += 1;
          continue;
        }
        break;
      }
      if (indentOf(next) <= baseIndent) break;
      itemLines.push(next.slice(Math.min(indentOf(next), baseIndent + 2)));
      index += 1;
    }
    items.push(buildItem(itemLines, depth));
  }
  const startNumber = ordered ? Number.parseInt(first?.[2] ?? "1", 10) : 1;
  out.push({ t: "list", ordered, start: Number.isFinite(startNumber) ? startNumber : 1, items });
  return index;
}

function buildItem(itemLines: string[], depth: number): ListItem {
  const head = itemLines[0] ?? "";
  const task = /^\[([ xX])\]\s+(.*)$/.exec(head);
  const lines = task ? [task[2] ?? "", ...itemLines.slice(1)] : itemLines;
  return {
    checked: task ? (task[1] ?? " ").toLowerCase() === "x" : null,
    blocks: parseBlocks(lines, depth + 1),
  };
}

function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.map((cell) => cell.trim());
}

function parseTable(lines: string[], start: number, out: Block[]): number {
  const head = splitRow(lines[start] ?? "");
  const align = splitRow(lines[start + 1] ?? "").map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center" as const;
    if (right) return "right" as const;
    return left ? ("left" as const) : null;
  });
  const rows: Inline[][][] = [];
  let index = start + 2;
  while (
    index < lines.length &&
    (lines[index] ?? "").trim() !== "" &&
    (lines[index] ?? "").includes("|")
  ) {
    rows.push(splitRow(lines[index] ?? "").map((cell) => parseInline(cell)));
    index += 1;
  }
  out.push({ t: "table", head: head.map((cell) => parseInline(cell)), rows, align });
  return index;
}

function startsAnotherBlock(line: string): boolean {
  return (
    line.trim() === "" ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line)
  );
}

function parseParagraph(lines: string[], start: number, out: Block[]): number {
  const text: string[] = [lines[start] ?? ""];
  let index = start + 1;
  while (index < lines.length && !startsAnotherBlock(lines[index] ?? "")) {
    text.push(lines[index] ?? "");
    index += 1;
  }
  out.push({ t: "paragraph", c: parseInline(text.join("\n")) });
  return index;
}

// --- Inline ---

const INLINE_TOKEN =
  /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|( {2,}|\\)\n/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest.length > 0) {
    const match = INLINE_TOKEN.exec(rest);
    if (!match) {
      pushText(out, rest);
      break;
    }
    if (match.index > 0) pushText(out, rest.slice(0, match.index));
    out.push(...tokenToInline(match));
    rest = rest.slice(match.index + match[0].length);
  }
  return out;
}

function pushText(out: Inline[], value: string): void {
  const cleaned = value.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1").replace(/\n/g, " ");
  if (cleaned === "") return;
  const last = out[out.length - 1];
  if (last?.t === "text") last.v += cleaned;
  else out.push({ t: "text", v: cleaned });
}

function tokenToInline(match: RegExpExecArray): Inline[] {
  if (match[2] !== undefined) return [{ t: "code", v: match[2].trim() }];
  if (match[3] !== undefined) return [{ t: "image", alt: match[3] === "" ? "image" : match[3] }];
  if (match[5] !== undefined) return linkInline(match[6] ?? "", parseInline(match[5]));
  if (match[7] !== undefined) return linkInline(match[7], [{ t: "text", v: match[7] }]);
  const strong = match[8] ?? match[9];
  if (strong !== undefined) return [{ t: "strong", c: parseInline(strong) }];
  if (match[10] !== undefined) return [{ t: "del", c: parseInline(match[10]) }];
  const em = match[11] ?? match[12];
  if (em !== undefined) return [{ t: "em", c: parseInline(em) }];
  return [{ t: "br" }];
}

/** A link whose target isn't safe degrades to its plain text — never a live link. */
function linkInline(href: string, children: Inline[]): Inline[] {
  return safeHref(href) ? [{ t: "link", href, c: children }] : children;
}

/** Plain text of inline content (for tests and accessible labels). */
export function inlineText(inlines: Inline[]): string {
  return inlines
    .map((node) => {
      switch (node.t) {
        case "text":
        case "code":
          return node.v;
        case "image":
          return node.alt;
        case "br":
          return "\n";
        default:
          return inlineText(node.c);
      }
    })
    .join("");
}
