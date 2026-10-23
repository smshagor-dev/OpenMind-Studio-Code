import { describe, it, expect, vi } from "vitest";
import { ExtensionTerminalService, type TerminalsForExtensions } from "./extensionTerminals";
function setup(shell: "powerShell" | "gitBash") {
  const write = vi.fn(async () => {}), closeTerminal = vi.fn(async () => {});
  const terminals = { subscribe: () => () => {}, getState: () => ({ shells: [{ kind: shell }], sessions: [] }), createTerminal: vi.fn(() => Promise.resolve("session")), closeTerminal, write } as unknown as TerminalsForExtensions;
  const service = new ExtensionTerminalService({ terminals, showPanel: async () => {}, confirm: () => Promise.resolve(null), notifyHost: () => {}, notice: () => {} });
  return { service, write, closeTerminal, terminals };
}
describe("debug terminal launch", () => {
  it("quotes executable, spaces, quotes and shell syntax literally in PowerShell", async () => {
    const r = setup("powerShell");
    await r.service.runDebuggee({ extension: "test.debug", id: "test.debug#debug-1", args: ["C:/My Tools/node.exe", "a'b", "$(touch bad)"], env: { KEEP: "a'b", REMOVE: null } });
    expect(r.write).toHaveBeenCalledWith("session", " $env:KEEP='a''b'; Remove-Item Env:REMOVE -ErrorAction SilentlyContinue; & 'C:/My Tools/node.exe' 'a''b' '$(touch bad)'\r".trimStart());
    await r.service.dispose({ extension: "test.debug", id: "test.debug#debug-1" });
    expect(r.closeTerminal).toHaveBeenCalledWith("session");
  });
  it("escapes single quotes in Bash and never evaluates debugger arguments", async () => {
    const r = setup("gitBash");
    await r.service.runDebuggee({ extension: "test.debug", id: "test.debug#debug-1", args: ["node", "a'b", "$(touch bad)"], env: {} });
    expect(r.write).toHaveBeenCalledWith("session", "'node' 'a'\\''b' '$(touch bad)'\r");
  });
  it("rejects invalid ownership, environment and control characters before creating a terminal", async () => {
    const r = setup("powerShell");
    for (const params of [{ extension: "test.debug", id: "other#debug-1", args: ["node"] }, { extension: "test.debug", id: "test.debug#debug-1", args: ["node\nbad"] }, { extension: "test.debug", id: "test.debug#debug-1", args: ["node"], env: { "BAD;KEY": "value" } }]) await expect(r.service.runDebuggee(params)).rejects.toThrow();
    expect(r.terminals.createTerminal).not.toHaveBeenCalled();
  });
});
