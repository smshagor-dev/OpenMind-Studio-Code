import { describe, expect, it } from "vitest";

import { CommandLineTracker } from "./commandLine";

describe("CommandLineTracker", () => {
  it("rebuilds the line typed key by key or pasted, with Backspace edits", () => {
    const t = new CommandLineTracker();
    for (const key of "pip installx") t.feed(key);
    t.feed("\u007f");
    expect(t.feed(" requests\r")).toBe("pip install requests");
    expect(t.last()).toBe("pip install requests");
    expect(t.feed("npm ci\r")).toBe("npm ci");
  });

  it("Ctrl+C clears the line; an empty Enter keeps the last command", () => {
    const t = new CommandLineTracker();
    t.feed("git fetch\r");
    t.feed("rm -rf x\u0003");
    expect(t.feed("\r")).toBeNull();
    expect(t.last()).toBe("git fetch");
  });

  it("the terminal's own replies and bracketed paste don't hide the typed command", () => {
    const t = new CommandLineTracker();
    // PowerShell asks for the cursor position; xterm answers through the same input channel.
    t.feed("\u001b[12;5R");
    t.feed("pip in");
    t.feed("\u001b[12;11R\u001b[I");
    expect(t.feed("stall requests\r")).toBe("pip install requests");
    // A paste arrives wrapped in bracketed-paste markers.
    expect(t.feed("\u001b[200~npm ci\u001b[201~\r")).toBe("npm ci");
  });

  it("a line edited with arrow keys or history is not guessed", () => {
    const t = new CommandLineTracker();
    t.feed("pip download six\r");
    expect(t.feed("\u001b[A\r")).toBeNull();
    expect(t.last()).toBe("pip download six");
  });
});
