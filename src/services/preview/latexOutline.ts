export type LatexBlock =
  | { kind: "title"; text: string }
  | { kind: "author"; text: string }
  | { kind: "section"; level: 1 | 2 | 3; text: string }
  | { kind: "equation"; text: string }
  | { kind: "bibliography"; text: string }
  | { kind: "text"; text: string };

export interface LatexOutline {
  blocks: LatexBlock[];
  /** Blocks beyond the cap were left out. */
  truncated: boolean;
}

const MAX_BLOCKS = 5000;
const SECTIONS: Record<string, 1 | 2 | 3> = {
  chapter: 1,
  section: 1,
  subsection: 2,
  subsubsection: 3,
};
const EQUATION_ENVIRONMENTS = [
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "eqnarray",
  "displaymath",
];

/** Removes an unescaped `%` comment from a line. */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    if (line.charAt(i) === "%" && line.charAt(i - 1) !== "\\") return line.slice(0, i);
  }
  return line;
}

/** The argument of `\name{...}` (balanced braces), or null. */
function braceArgument(line: string, name: string): string | null {
  const match = new RegExp(`\\\\${name}\\*?(?:\\[[^\\]]*\\])?\\s*\\{`).exec(line);
  if (!match) return null;
  let depth = 1;
  let out = "";
  for (let i = match.index + match[0].length; i < line.length; i += 1) {
    const char = line.charAt(i);
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return out.trim();
    }
    out += char;
  }
  return out.trim();
}

/**
 * A structured reading of LaTeX *source* — title, author, sections, equations, bibliography commands and paragraphs.
 * Nothing is compiled or executed; unknown commands stay as plain text.
 */
export function outlineLatex(source: string): LatexOutline {
  const blocks: LatexBlock[] = [];
  let truncated = false;
  const push = (block: LatexBlock) => {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      return;
    }
    blocks.push(block);
  };

  let paragraph: string[] = [];
  const flush = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (text !== "") push({ kind: "text", text });
    paragraph = [];
  };

  let equation: string[] | null = null;
  let equationEnd = "";
  let inBibliography = false;
  const lines = source.split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const line = stripComment(raw);
    const trimmed = line.trim();
    if (equation !== null) {
      if (trimmed.includes(equationEnd)) {
        const before = trimmed.slice(0, trimmed.indexOf(equationEnd)).trim();
        if (before !== "") equation.push(before);
        push({ kind: "equation", text: equation.join("\n") });
        equation = null;
      } else {
        equation.push(trimmed);
      }
      continue;
    }
    if (inBibliography) {
      if (/\\end\{thebibliography\}/.test(trimmed)) inBibliography = false;
      else if (trimmed !== "") push({ kind: "bibliography", text: trimmed });
      continue;
    }
    if (trimmed === "") {
      flush();
      continue;
    }
    const environment = EQUATION_ENVIRONMENTS.find((name) =>
      trimmed.startsWith(`\\begin{${name}}`),
    );
    if (environment !== undefined) {
      flush();
      equationEnd = `\\end{${environment}}`;
      equation = [];
      const rest = trimmed.slice(`\\begin{${environment}}`.length).trim();
      if (rest.includes(equationEnd)) {
        push({ kind: "equation", text: rest.slice(0, rest.indexOf(equationEnd)).trim() });
        equation = null;
      } else if (rest !== "") equation.push(rest);
      continue;
    }
    if (trimmed.startsWith("\\[") || trimmed.startsWith("$$")) {
      flush();
      const open = trimmed.startsWith("\\[") ? "\\[" : "$$";
      const close = open === "\\[" ? "\\]" : "$$";
      const rest = trimmed.slice(open.length);
      const end = rest.indexOf(close);
      if (end >= 0) push({ kind: "equation", text: rest.slice(0, end).trim() });
      else {
        equationEnd = close;
        equation = rest.trim() === "" ? [] : [rest.trim()];
      }
      continue;
    }
    if (/\\begin\{thebibliography\}/.test(trimmed)) {
      flush();
      inBibliography = true;
      continue;
    }
    const bib =
      /\\(bibliography|bibliographystyle|addbibresource|printbibliography)\b(?:\{[^}]*\})?/.exec(
        trimmed,
      );
    if (bib) {
      flush();
      push({ kind: "bibliography", text: bib[0] });
      continue;
    }
    const title = braceArgument(trimmed, "title");
    if (title !== null) {
      flush();
      push({ kind: "title", text: title });
      continue;
    }
    const author = braceArgument(trimmed, "author");
    if (author !== null) {
      flush();
      push({ kind: "author", text: author });
      continue;
    }
    const heading = /^\\(chapter|section|subsection|subsubsection)\*?/.exec(trimmed);
    const level = heading?.[1] === undefined ? undefined : SECTIONS[heading[1]];
    if (heading && level !== undefined) {
      flush();
      push({ kind: "section", level, text: braceArgument(trimmed, heading[1] ?? "") ?? trimmed });
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  if (equation !== null && equation.length > 0)
    push({ kind: "equation", text: equation.join("\n") });
  return { blocks, truncated };
}
