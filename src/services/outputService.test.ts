import { describe, expect, it } from "vitest";

import { OutputService } from "./outputService";

describe("OutputService", () => {
  it("gives a channel that doesn't exist yet the same empty array every time", () => {
    // A new array per call makes useSyncExternalStore re-render forever (React error #185).
    const output = new OutputService();
    const first = output.getLines("Python");
    expect(first).toEqual([]);
    expect(output.getLines("Python")).toBe(first);
  });

  it("returns a new array once the channel changes", () => {
    const output = new OutputService();
    const before = output.getLines("Run Code");
    output.append("Run Code", "hello");
    expect(output.getLines("Run Code")).not.toBe(before);
    expect(output.getLines("Run Code")).toEqual(["hello"]);
  });
});
