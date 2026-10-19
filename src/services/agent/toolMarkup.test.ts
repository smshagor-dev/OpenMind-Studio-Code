import { describe, expect, it } from "vitest";
import { withoutToolMarkup } from "./toolMarkup";

describe("withoutToolMarkup", () => {
  it("leaves ordinary text unchanged", () => {
    expect(withoutToolMarkup("Done. The file is fixed.")).toBe("Done. The file is fixed.");
  });

  it("hides a function-style call", () => {
    const text = "I'll read it.\n<function=read_file><parameter=path>\nsrc/a.ts\n</parameter></function>\nThen fix.";
    expect(withoutToolMarkup(text)).toBe("I'll read it.\n\nThen fix.");
  });

  it("hides a tool_call block and a stray closing tag", () => {
    expect(withoutToolMarkup('Looking.<tool_call>{"name":"list_dir","arguments":{}}</tool_call>')).toBe("Looking.");
    expect(withoutToolMarkup("Ok</tool_call>")).toBe("Ok");
  });

  it("hides a call that is still streaming at the end", () => {
    expect(withoutToolMarkup("Checking.\n<function=run_command><parameter=command>np")).toBe("Checking.\n");
  });

  it("keeps markup inside fenced code", () => {
    const text = "Example:\n```\n<tool_call>{\"name\":\"x\"}</tool_call>\n```\n";
    expect(withoutToolMarkup(text)).toBe(text);
  });
});
