import { describe, expect, it } from "vitest";
import {
  AGENT_COMMANDS,
  commandHelp,
  matchingCommands,
  parseAgentCommand,
  savedGoal,
  transcriptMarkdown,
} from "./agentCommands";
describe("agent command registry", () => {
  it("resolves every requested command, including compatibility spellings", () => {
    const names =
      "help model effect permission config new clear resume compact context memory diff review mcp pluging task doctor export fork init goal stop".split(
        " ",
      );
    for (const name of names)
      expect(parseAgentCommand(`/${name}`)?.command, name).toBeTruthy();
    expect(new Set(AGENT_COMMANDS.map((c) => c.name)).size).toBe(
      AGENT_COMMANDS.length,
    );
  });
  it("preserves multiline arguments and searches aliases", () => {
    expect(parseAgentCommand(" /MEMORY set first\nsecond ")?.argument).toBe(
      "set first\nsecond",
    );
    expect(matchingCommands("/effec")[0]?.name).toBe("effort");
    expect(parseAgentCommand("/pluging install")?.command?.name).toBe(
      "plugins",
    );
    expect(parseAgentCommand("/unknown")?.command).toBeNull();
    expect(parseAgentCommand("normal prompt")).toBeNull();
    expect(commandHelp("effect")).toContain("/effort");
  });
  it("restores active goals paused and exports actual message contents without binary payloads", () => {
    expect(
      savedGoal({ text: "ship", state: "active", attempts: 100 })?.state,
    ).toBe("paused");
    expect(savedGoal({ text: "", state: "active" })).toBeNull();
    const markdown = transcriptMarkdown([
      { kind: "user", id: "u", text: "Hello" },
      { kind: "assistant", id: "a", text: "Done", reasoning: "Checked" },
      { kind: "asset", id: "i", name: "image.png", data: "secret-binary" },
    ]);
    expect(markdown).toContain("Hello");
    expect(markdown).toContain("Done");
    expect(markdown).toContain("Checked");
    expect(markdown).not.toContain("secret-binary");
  });
});
