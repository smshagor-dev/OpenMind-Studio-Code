import * as monaco from "monaco-editor";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EditorAiActions,
  codeAttachments,
  focusRange,
  reviewPrompt,
  type EditorAiHost,
  type EditorSnapshot,
} from "./editorAiActions";
import { InlineChatService, cleanAnswer, inlineMessages, type InlineEditor, type InlineHost } from "./inlineChat";

function snapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  const text = Array.from({ length: 100 }, (_, i) => `line ${String(i + 1)}`).join("\n");
  return {
    path: "C:/p/src/a.ts",
    relative: "src/a.ts",
    language: "typescript",
    text,
    selection: { startLine: 40, endLine: 42, text: "line 40\nline 41\nline 42" },
    cursorLine: 40,
    ...overrides,
  };
}

function aiHost(overrides: Partial<EditorAiHost> = {}): EditorAiHost {
  return {
    attachText: vi.fn(),
    send: vi.fn(() => Promise.resolve(true)),
    blocker: () => null,
    showAgent: vi.fn(),
    notice: vi.fn(),
    t: (key) => key,
    ...overrides,
  };
}

describe("EditorAiActions", () => {
  it("attaches the selection with its file and lines, or the whole file", () => {
    const host = aiHost();
    const actions = new EditorAiActions(host);
    actions.addFileToChat(snapshot());
    expect(host.attachText).toHaveBeenCalledWith(
      "src/a.ts:40-42",
      expect.stringContaining("File: src/a.ts (lines 40-42, typescript)"),
    );
    actions.addFileToChat(snapshot({ selection: null }));
    expect(host.attachText).toHaveBeenLastCalledWith("src/a.ts", expect.stringContaining("line 100"));
    expect(host.showAgent).toHaveBeenCalledTimes(2);
  });

  it("sends Explain and Review read-only (plan mode) with the code and its surroundings", async () => {
    const host = aiHost();
    const actions = new EditorAiActions(host);
    await actions.review(snapshot());
    const [prompt, attachments, mode] = vi.mocked(host.send).mock.calls[0] ?? [];
    expect(mode).toBe("plan");
    expect(prompt).toContain("possible issue");
    expect(prompt).toContain("Do not change any files.");
    expect(attachments).toHaveLength(2);
    expect(attachments?.[1]?.text).toContain("line 20");
    await actions.explain(snapshot());
    expect(vi.mocked(host.send).mock.calls[1]?.[2]).toBe("plan");
  });

  it("says why the agent can't take the request, after showing its panel", async () => {
    const host = aiHost({ blocker: () => "Download a model first." });
    await expect(new EditorAiActions(host).explain(snapshot())).rejects.toThrow("Download a model first.");
    expect(host.showAgent).toHaveBeenCalled();
    expect(host.send).not.toHaveBeenCalled();
  });

  it("focuses on the selection, a small whole file, or the code around the cursor", () => {
    expect(focusRange(snapshot())).toEqual({ startLine: 40, endLine: 42 });
    expect(focusRange(snapshot({ selection: null }))).toEqual({ startLine: 1, endLine: 100 });
    const big = Array.from({ length: 1000 }, () => "x").join("\n");
    expect(focusRange(snapshot({ selection: null, text: big, cursorLine: 500 }))).toEqual({
      startLine: 470,
      endLine: 530,
    });
    expect(codeAttachments(snapshot({ selection: null }))).toHaveLength(1);
    expect(reviewPrompt(snapshot())).toContain("src/a.ts, lines 40-42");
  });

  it("fences code that contains backticks with a longer fence", () => {
    const tricky = snapshot({
      text: "```js\nx\n```",
      selection: { startLine: 1, endLine: 3, text: "```js\nx\n```" },
    });
    const [first] = codeAttachments(tricky);
    expect(first?.text).toContain("````typescript");
  });
});

describe("inline chat helpers", () => {
  it("takes the code out of a fenced answer and trims blank edges", () => {
    expect(cleanAnswer("Here you go:\n```ts\nconst a = 1;\n```\nDone.")).toBe("const a = 1;");
    expect(cleanAnswer("\n\n  return x;\n\n")).toBe("  return x;");
  });

  it("builds the conversation with the code around the selection and earlier turns", () => {
    const first = inlineMessages({ name: "a.ts", language: "typescript" }, "before", "sel", "after", [], "rename x");
    expect(first).toHaveLength(2);
    expect(first[1]?.content).toContain("<selection>\nsel\n</selection>");
    expect(first[1]?.content).toContain("Instruction: rename x");
    const refined = inlineMessages(
      { name: "a.ts", language: "typescript" },
      "b",
      "",
      "a",
      [{ instruction: "add a loop", proposal: "for (;;) {}" }],
      "use while",
    );
    expect(refined.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(refined[1]?.content).toContain("Nothing is selected");
    expect(refined[3]?.content).toBe("Change it: use while");
  });
});

describe("InlineChatService", () => {
  const models: monaco.editor.ITextModel[] = [];
  afterEach(() => {
    for (const model of models.splice(0)) model.dispose();
  });

  function setup(answer: string | Error = "const b = 2;") {
    const model = monaco.editor.createModel("const a = 1;\nkeep\n", "plaintext");
    models.push(model);
    const editor: InlineEditor = {
      getModel: () => model,
      executeEdits: (_source, edits) => {
        model.pushEditOperations(
          [],
          edits.map((edit) => ({ range: edit.range, text: edit.text })),
          () => null,
        );
        return true;
      },
      pushUndoStop: () => true,
      focus: vi.fn(),
    };
    const host: InlineHost = {
      ipc: {
        complete: vi.fn(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer))),
        cancel: vi.fn(() => Promise.resolve()),
      },
      model: () => ({ modelId: "m", useGpu: true, contextTokens: 0 }),
      describe: () => ({ name: "a.ts", language: "plaintext" }),
      t: (key) => key,
    };
    const service = new InlineChatService(host);
    service.open(editor, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 13 });
    return { service, model, host };
  }

  it("proposes a change and applies it only on Accept, as one edit", async () => {
    const { service, model } = setup("```\nconst b = 2;\n```");
    await service.submit("rename");
    expect(service.getState()?.status).toBe("proposed");
    expect(model.getValue()).toBe("const a = 1;\nkeep\n");
    service.accept();
    expect(model.getValue()).toBe("const b = 2;\nkeep\n");
    expect(service.getState()).toBeNull();
  });

  it("Reject leaves the code untouched", async () => {
    const { service, model } = setup();
    await service.submit("rename");
    service.reject();
    expect(model.getValue()).toBe("const a = 1;\nkeep\n");
  });

  it("refuses to accept when the code under the selection changed meanwhile", async () => {
    const { service, model } = setup();
    await service.submit("rename");
    model.setValue("const z = 9;\nkeep\n");
    service.accept();
    expect(service.getState()?.error).toBe("inlineChat.changed");
    expect(model.getValue()).toBe("const z = 9;\nkeep\n");
  });

  it("shows a failure, and a refinement sends the earlier proposal along", async () => {
    const failing = setup(new Error("The local engine is in use"));
    await failing.service.submit("x");
    expect(failing.service.getState()).toMatchObject({ status: "error", error: "The local engine is in use" });
    const { service, host } = setup();
    await service.submit("first");
    await service.submit("second");
    const messages = vi.mocked(host.ipc.complete).mock.calls[1]?.[0].messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("says why when no model is set up", async () => {
    const { service, host } = setup();
    host.model = () => ({ blocked: "Set up the agent first." });
    await service.submit("x");
    expect(service.getState()?.error).toBe("Set up the agent first.");
    expect(host.ipc.complete).not.toHaveBeenCalled();
  });
});
