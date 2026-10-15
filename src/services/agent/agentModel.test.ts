import { describe, expect, it } from "vitest";

import type { AgentEvent } from "./agentIpc";
import {
  addUser,
  applyEvent,
  completeMention,
  EMPTY_TRANSCRIPT,
  formatBytes,
  formatElapsed,
  formatTokens,
  mentionQuery,
  nextMode,
  type Transcript,
} from "./agentModel";

const say = (notice: { key: string; message: string | null }) =>
  notice.message ? `${notice.key} ${notice.message}` : notice.key;

function run(events: AgentEvent[], start: Transcript = addUser(EMPTY_TRANSCRIPT, "fix it", 1000)): Transcript {
  return events.reduce((t, e) => applyEvent(t, e, say), start);
}

describe("agent transcript", () => {
  it("streams thinking and text into one assistant message", () => {
    const t = run([
      { type: "thinking", step: 0 },
      { type: "reasoning", text: "I should " },
      { type: "reasoning", text: "read it." },
      { type: "text", text: "Done" },
      { type: "text", text: "!" },
    ]);
    expect(t.entries).toHaveLength(2);
    const assistant = t.entries[1];
    expect(assistant).toMatchObject({ kind: "assistant", reasoning: "I should read it.", text: "Done!" });
    expect(t.phase).toBe("responding");
    expect(t.busy).toBe(true);
  });

  it("puts a tool card between messages and follows its life", () => {
    let t = run([
      { type: "text", text: "Let me fix it." },
      { type: "toolStart", id: "c1", name: "edit_file", kind: "edit", title: "Update", target: "main.py" },
    ]);
    expect(t.phase).toBe("tool");
    t = run(
      [
        {
          type: "permission",
          request: { id: "c1", kind: "edit", title: "Update", target: "main.py", diff: null },
        },
      ],
      t,
    );
    expect(t.phase).toBe("waiting");
    expect(t.permission?.id).toBe("c1");
    expect(t.entries[2]).toMatchObject({ kind: "tool", status: "waiting" });
    t = run(
      [
        {
          type: "toolEnd",
          id: "c1",
          ok: true,
          summary: "Added 1 line, removed 1 line",
          preview: "",
          diff: { added: 1, removed: 1, lines: [], truncated: false },
          changed: { path: "C:/p/main.py", rel: "main.py", kind: "modified" },
        },
        { type: "text", text: "Fixed." },
      ],
      t,
    );
    expect(t.permission).toBeNull();
    expect(t.canUndo).toBe(true);
    expect(t.entries[2]).toMatchObject({ status: "ok", changedPath: "C:/p/main.py" });
    // Text after a tool card is a new message, as in Claude Code.
    expect(t.entries[3]).toMatchObject({ kind: "assistant", text: "Fixed." });
  });

  it("marks a declined action and ends the turn with a notice", () => {
    const t = run([
      { type: "toolStart", id: "c1", name: "run_command", kind: "command", title: "Run", target: "rm -rf x" },
      { type: "toolEnd", id: "c1", ok: false, summary: "Declined", preview: "", diff: null, changed: null },
      { type: "turnEnd", reason: "rejected", message: null },
    ]);
    expect(t.entries[1]).toMatchObject({ status: "declined" });
    expect(t.busy).toBe(false);
    expect(t.entries[2]).toMatchObject({ kind: "notice", text: "agent.end.rejected" });
  });

  it("an interrupted turn leaves no tool spinning", () => {
    const t = run([
      { type: "toolStart", id: "c1", name: "run_command", kind: "command", title: "Run", target: "npm test" },
      { type: "turnEnd", reason: "cancelled", message: null },
    ]);
    expect(t.entries[1]).toMatchObject({ status: "declined" });
    expect(t.entries[2]).toMatchObject({ kind: "notice", tone: "info", text: "agent.end.interrupted" });
    expect(t.startedAt).toBeNull();
  });

  it("an error keeps its message and a normal end adds nothing", () => {
    const failed = run([{ type: "turnEnd", reason: "error", message: "out of memory" }]);
    expect(failed.entries[1]).toMatchObject({ tone: "error", text: "agent.end.error out of memory" });
    const done = run([{ type: "turnEnd", reason: "done", message: null }]);
    expect(done.entries).toHaveLength(1);
  });

  it("counts tokens and follows the engine", () => {
    const t = run([
      { type: "engine", state: "loading", model: "m", message: null },
      { type: "usage", promptTokens: 900, completionTokens: 40, contextTokens: 32768 },
      { type: "usage", promptTokens: 1200, completionTokens: 25, contextTokens: 32768 },
    ]);
    expect(t.phase).toBe("loadingModel");
    expect(t.outputTokens).toBe(65);
    expect(t.promptTokens).toBe(1200);
    expect(t.contextTokens).toBe(32768);
  });

  it("keeps the latest task list", () => {
    const t = run([{ type: "todos", items: [{ content: "Fix add", status: "in_progress" }] }]);
    expect(t.todos).toEqual([{ content: "Fix add", status: "in_progress" }]);
  });
});

describe("agent helpers", () => {
  it("cycles modes like Shift+Tab in Claude Code", () => {
    expect(nextMode("ask")).toBe("acceptEdits");
    expect(nextMode("acceptEdits")).toBe("plan");
    expect(nextMode("plan")).toBe("ask");
  });

  it("formats sizes, tokens and time", () => {
    expect(formatBytes(2_837_072_864)).toBe("2.6 GB");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MB");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
  });

  it("finds and completes an @ file mention", () => {
    expect(mentionQuery("look at @src/ma", 15)).toBe("src/ma");
    expect(mentionQuery("mail me@home", 12)).toBeNull();
    expect(mentionQuery("@", 1)).toBe("");
    const done = completeMention("look at @src/ma please", 15, "src/main.py");
    expect(done.text).toBe("look at @src/main.py  please");
    expect(done.caret).toBe("look at @src/main.py ".length);
  });
});
