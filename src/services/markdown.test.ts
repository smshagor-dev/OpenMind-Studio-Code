import { describe, expect, it } from "vitest";

import { inlineText, parseInline, parseMarkdown, safeHref } from "./markdown";

describe("parseMarkdown blocks", () => {
  it("parses headings, paragraphs and rules", () => {
    const blocks = parseMarkdown("# Title\n\nSome *text*\nacross lines.\n\n---\n\n### Third ###");

    expect(blocks.map((b) => b.t)).toEqual(["heading", "paragraph", "hr", "heading"]);
    expect(blocks[0]).toMatchObject({ t: "heading", level: 1 });
    expect(blocks[3]).toMatchObject({ t: "heading", level: 3 });
    const paragraph = blocks[1];
    expect(paragraph?.t === "paragraph" ? inlineText(paragraph.c) : "").toBe(
      "Some text across lines.",
    );
  });

  it("parses fenced code blocks verbatim, including markdown-looking content", () => {
    const [block] = parseMarkdown("```ts\nconst a = *not em*;\n# not a heading\n```");

    expect(block).toEqual({ t: "code", lang: "ts", v: "const a = *not em*;\n# not a heading" });
  });

  it("an unterminated fence runs to the end instead of losing content", () => {
    const [block] = parseMarkdown("```\nline one\nline two");

    expect(block).toMatchObject({ t: "code", v: "line one\nline two" });
  });

  it("parses block quotes containing other blocks", () => {
    const [block] = parseMarkdown("> quoted\n> - item");

    expect(block?.t).toBe("quote");
    if (block?.t === "quote") expect(block.c.map((b) => b.t)).toEqual(["paragraph", "list"]);
  });

  it("parses bulleted, numbered, task and nested lists", () => {
    const [bullets, numbers] = parseMarkdown(
      "- one\n- two\n  - nested\n- [x] done\n- [ ] todo\n\n3. three\n4. four",
    );

    expect(bullets?.t).toBe("list");
    if (bullets?.t === "list") {
      expect(bullets.ordered).toBe(false);
      expect(bullets.items).toHaveLength(4);
      expect(bullets.items[1]?.blocks.map((b) => b.t)).toEqual(["paragraph", "list"]);
      expect(bullets.items[2]?.checked).toBe(true);
      expect(bullets.items[3]?.checked).toBe(false);
    }
    expect(numbers).toMatchObject({ t: "list", ordered: true, start: 3 });
  });

  it("parses tables with alignment", () => {
    const [table] = parseMarkdown("| A | B |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |");

    expect(table?.t).toBe("table");
    if (table?.t === "table") {
      expect(table.align).toEqual(["left", "right"]);
      expect(table.rows).toHaveLength(2);
      expect(inlineText(table.head[0] ?? [])).toBe("A");
    }
  });

  it("handles CRLF input and empty documents", () => {
    expect(parseMarkdown("# A\r\n\r\ntext")).toHaveLength(2);
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });

  it("deeply nested quotes stop nesting instead of recursing without bound", () => {
    const blocks = parseMarkdown(`${"> ".repeat(50)}deep`);

    expect(blocks).toHaveLength(1);
  });
});

describe("badges and other linked images", () => {
  it("a linked badge becomes a link with its alt text, never raw markdown, and loads nothing", () => {
    const [node] = parseInline("[![Build Status](https://ci.example.com/badge.svg)](https://github.com/x/y/actions)");
    expect(node).toMatchObject({ t: "link", href: "https://github.com/x/y/actions" });
    expect(inlineText(parseInline("[![Build Status](https://ci.example.com/badge.svg)](https://github.com/x/y)"))).toBe("Build Status");
    // A bare image is its alt text; a link with an unsafe target is plain text.
    expect(inlineText(parseInline("![Marketplace](https://img.shields.io/x.svg)"))).toBe("Marketplace");
    expect(parseInline("[![a](https://x/i.svg)](javascript:alert(1))").some((n) => n.t === "link")).toBe(false);
    const line = inlineText(
      parseInline("![Visual Studio Marketplace](https://marketplace.example/x) ![License](https://x/l.svg)"),
    );
    expect(line).toBe("Visual Studio Marketplace License");
    expect(line).not.toContain("](");
  });
});

describe("parseInline", () => {
  it("parses emphasis, strong, strike and code", () => {
    expect(parseInline("a **b** *c* ~~d~~ `e`").map((n) => n.t)).toEqual([
      "text",
      "strong",
      "text",
      "em",
      "text",
      "del",
      "text",
      "code",
    ]);
  });

  it("does not treat underscores inside words as emphasis", () => {
    expect(inlineText(parseInline("snake_case_name"))).toBe("snake_case_name");
    expect(parseInline("snake_case_name")).toEqual([{ t: "text", v: "snake_case_name" }]);
  });

  it("keeps raw HTML as literal text — it is never interpreted", () => {
    const inline = parseInline('<script>alert(1)</script> <img src=x onerror="alert(1)">');

    expect(inline.every((n) => n.t === "text")).toBe(true);
    expect(inlineText(inline)).toContain("<script>alert(1)</script>");
  });

  it("renders links only for safe targets and degrades the rest to plain text", () => {
    expect(parseInline("[ok](https://example.com)")[0]).toMatchObject({ t: "link" });
    expect(parseInline("[rel](docs/a.md)")[0]).toMatchObject({ t: "link" });
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///C:/Windows/win.ini",
      "vbscript:x",
      "//evil.example",
    ]) {
      const nodes = parseInline(`[click](${bad})`);
      expect(
        nodes.some((node) => node.t === "link"),
        bad,
      ).toBe(false);
      expect(inlineText(nodes), bad).toContain("click");
    }
  });

  it("autolinks http(s) URLs and shows images as their alt text only", () => {
    expect(parseInline("<https://a.dev/x>")[0]).toMatchObject({
      t: "link",
      href: "https://a.dev/x",
    });
    expect(parseInline("![logo](https://a.dev/i.png)")).toEqual([{ t: "image", alt: "logo" }]);
  });

  it("unescapes backslash-escaped punctuation", () => {
    expect(inlineText(parseInline("2 \\* 3 \\* 4"))).toBe("2 * 3 * 4");
  });
});

describe("safeHref", () => {
  it("classifies web, file and anchor targets", () => {
    expect(safeHref("https://a.dev/p?q=1")).toEqual({ kind: "web", url: "https://a.dev/p?q=1" });
    expect(safeHref("#section")).toEqual({ kind: "anchor", id: "section" });
    expect(safeHref("./docs/a%20b.md#x")).toEqual({ kind: "file", path: "./docs/a b.md" });
  });

  it("refuses schemes, absolute paths, control characters and empties", () => {
    for (const bad of [
      "mailto:a@b.c",
      "C:\\x",
      "/etc/passwd",
      "\\\\host\\share",
      "",
      " ",
      "a\u0000b",
    ]) {
      expect(safeHref(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
