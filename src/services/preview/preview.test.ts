import { describe, expect, it } from "vitest";

import { CSV_MAX_COLS, detectDelimiter, parseCsv } from "./csv";
import { describeHtmlSource } from "./htmlCheck";
import { outlineLatex, stripComment } from "./latexOutline";
import { describeSvg } from "./svgCheck";

describe("parseCsv", () => {
  it("parses quotes, embedded delimiters, doubled quotes, line breaks in cells and CRLF", () => {
    const table = parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\r\n"multi\nline",,\r\n');
    expect(table.rows).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'say "hi"'],
      ["multi\nline", "", ""],
    ]);
    expect(table.totalRows).toBe(3);
    expect(table.totalCols).toBe(3);
    expect(table.truncatedRows).toBe(false);
  });

  it("detects semicolons, tabs and pipes and ignores a BOM", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3\n")).toBe("|");
    expect(parseCsv("﻿name;age\nann;3").rows[0]).toEqual(["name", "age"]);
  });

  it("keeps only the first rows and columns but counts everything", () => {
    const lines = Array.from({ length: 2500 }, (_, n) => `${String(n)},x`).join("\n");
    const table = parseCsv(lines, { maxRows: 1000 });
    expect(table.rows).toHaveLength(1000);
    expect(table.totalRows).toBe(2500);
    expect(table.truncatedRows).toBe(true);
    const wide = parseCsv(Array.from({ length: CSV_MAX_COLS + 50 }, (_, n) => String(n)).join(","));
    expect(wide.rows[0]).toHaveLength(CSV_MAX_COLS);
    expect(wide.truncatedCols).toBe(true);
    expect(wide.totalCols).toBe(CSV_MAX_COLS + 50);
  });

  it("pads short rows, handles a last line with no break and an empty file", () => {
    expect(parseCsv("a,b,c\n1").rows).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
    ]);
    expect(parseCsv("").rows).toEqual([]);
    expect(parseCsv("").totalRows).toBe(0);
  });

  it("an unterminated quote does not hang or lose the text", () => {
    const table = parseCsv('a,"never closed\nstill in the cell');
    expect(table.rows[0]?.[1]).toContain("never closed");
  });
});

describe("outlineLatex", () => {
  const source = String.raw`\documentclass{article}
% a comment with \section{Hidden}
\title{A Study of \emph{Things}}
\author{Ann Example}
\begin{document}
\maketitle
\section{Introduction}
Some text on the first line
and a second one. 50\% of it.

\subsection*{Details}
\begin{equation}
E = mc^2
\end{equation}
$$ a^2 + b^2 = c^2 $$
\bibliographystyle{plain}
\bibliography{refs}
\end{document}`;

  it("finds the title, author, sections, equations, bibliography commands and paragraphs", () => {
    const { blocks } = outlineLatex(source);
    const kinds = blocks.map((block) => block.kind);
    expect(kinds).toContain("title");
    expect(blocks.find((b) => b.kind === "title")).toMatchObject({
      text: String.raw`A Study of \emph{Things}`,
    });
    expect(blocks.find((b) => b.kind === "author")).toMatchObject({ text: "Ann Example" });
    expect(blocks.filter((b) => b.kind === "section")).toEqual([
      { kind: "section", level: 1, text: "Introduction" },
      { kind: "section", level: 2, text: "Details" },
    ]);
    expect(blocks.filter((b) => b.kind === "equation").map((b) => b.text)).toEqual([
      "E = mc^2",
      "a^2 + b^2 = c^2",
    ]);
    expect(blocks.filter((b) => b.kind === "bibliography").map((b) => b.text)).toEqual([
      String.raw`\bibliographystyle{plain}`,
      String.raw`\bibliography{refs}`,
    ]);
    // Commented-out commands are not read, and escaped percent signs stay text.
    expect(blocks.some((b) => b.text.includes("Hidden"))).toBe(false);
    expect(blocks.find((b) => b.kind === "text" && b.text.includes("first line"))?.text).toContain(
      String.raw`50\% of it.`,
    );
  });

  it("stripComment only removes an unescaped percent", () => {
    expect(stripComment(String.raw`100\% sure % note`)).toBe(String.raw`100\% sure `);
  });

  it("caps the number of blocks", () => {
    const many = Array.from({ length: 6000 }, (_, n) => `\\section{S${String(n)}}`).join("\n");
    const outline = outlineLatex(many);
    expect(outline.blocks).toHaveLength(5000);
    expect(outline.truncated).toBe(true);
  });
});

describe("describeSvg", () => {
  it("is quiet for a plain drawing", () => {
    expect(describeSvg('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>')).toBeNull();
  });

  it("names scripts, handlers, embedded HTML and external references", () => {
    const note = describeSvg(
      '<svg><script>alert(1)</script><rect onclick="x()"/><foreignObject/><image href="https://evil.test/a.png"/></svg>',
    );
    expect(note).toContain("scripts");
    expect(note).toContain("event handlers");
    expect(note).toContain("embedded HTML");
    expect(note).toContain("external references");
    expect(note).toContain("scripts do not run");
  });
});

describe("describeHtmlSource", () => {
  it("counts scripts, inline handlers, obfuscated javascript: links and forms", () => {
    const notices = describeHtmlSource(
      '<script>x()</script><script src="a.js"></script><p onclick="x()">a</p><a href="java\nscript:alert(1)">l</a><form action="/x"></form>',
    );
    expect(notices.join(" | ")).toContain("2 scripts blocked");
    expect(notices.join(" | ")).toContain("1 inline event handler blocked");
    expect(notices.join(" | ")).toContain("1 script link");
    expect(notices.join(" | ")).toContain("Forms");
  });

  it("says nothing for a plain page", () => {
    expect(describeHtmlSource("<h1>Hi</h1><p>text</p>")).toEqual([]);
  });
});
