import { describe, expect, it } from "vitest";

import { splitSegments } from "./aiMessageText";

describe("splitSegments", () => {
  it("splits prose and fenced code with the language", () => {
    expect(splitSegments("Here it is:\n```ts\nconst a = 1;\n```\nDone.")).toEqual([
      { type: "text", text: "Here it is:" },
      { type: "code", language: "ts", code: "const a = 1;", closed: true },
      { type: "text", text: "Done." },
    ]);
  });

  it("keeps a block that is still streaming (no closing fence yet)", () => {
    expect(splitSegments("Sure\n```python\nprint(1)")).toEqual([
      { type: "text", text: "Sure" },
      { type: "code", language: "python", code: "print(1)", closed: false },
    ]);
  });

  it("does not close a block on a shorter fence or on text", () => {
    expect(splitSegments("````md\n```\ninner\n```\n````")).toEqual([
      { type: "code", language: "md", code: "```\ninner\n```", closed: true },
    ]);
  });

  it("treats a message without fences as plain text and never as HTML", () => {
    expect(splitSegments("<script>alert(1)</script>\n\nsecond paragraph")).toEqual([
      { type: "text", text: "<script>alert(1)</script>\n\nsecond paragraph" },
    ]);
    expect(splitSegments("")).toEqual([]);
  });
});
