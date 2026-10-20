import * as monaco from "monaco-editor";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitBlameLine } from "../ipc";
import { changeDecorations, FileAnnotationsService, heatBucket, relativeTime, type AnnotatedEditor } from "./fileAnnotations";
import type { FileGitIpc } from "./fileGitIpc";
import { diffLines } from "./lineDiff";

const NOW = Date.UTC(2026, 9, 20);
const DAY = 86_400;

function blame(line: number, content: string, daysAgo: number): GitBlameLine {
  return {
    line,
    originalLine: line,
    hash: "a".repeat(40),
    shortHash: "aaaaaaa",
    author: "Ada",
    time: NOW / 1000 - daysAgo * DAY,
    summary: "a change",
    content,
    committed: true,
  };
}

describe("annotation helpers", () => {
  it("formats relative times in the UI language", () => {
    expect(relativeTime(NOW / 1000 - 3 * DAY, NOW, "en")).toBe("3 days ago");
    expect(relativeTime(NOW / 1000 - 2 * 31_536_000, NOW, "en")).toBe("2 years ago");
    expect(relativeTime(NOW / 1000 - 3 * DAY, NOW, "ru")).toContain("3");
  });

  it("puts newer lines in warmer buckets and uncommitted lines in none", () => {
    expect(heatBucket(NOW / 1000, NOW, 365)).toBe(0);
    expect(heatBucket(NOW / 1000 - 200 * DAY, NOW, 365)).toBe(5);
    expect(heatBucket(NOW / 1000 - 5000 * DAY, NOW, 365)).toBe(9);
    expect(heatBucket(0, NOW, 365)).toBeNull();
  });

  it("turns changes into gutter bars and a deletion marker inside the file", () => {
    const decorations = changeDecorations(diffLines("a\nb\nc\n", "a\nB\nc\nd\n"), 4);
    expect(decorations.map((d) => d.options.linesDecorationsClassName)).toEqual([
      "git-change git-change--modified",
      "git-change git-change--added",
    ]);
    const deleted = changeDecorations(diffLines("a\nb\n", "a\n"), 1);
    expect(deleted[0]?.range.startLineNumber).toBe(1);
    expect(changeDecorations(null, 3)).toEqual([]);
  });
});

describe("FileAnnotationsService", () => {
  const models: monaco.editor.ITextModel[] = [];
  afterEach(() => {
    for (const model of models.splice(0)) model.dispose();
  });

  function setup(settings: Record<string, boolean>, text = "one\nnew\ntwo\n") {
    const model = monaco.editor.createModel(text, "plaintext");
    models.push(model);
    let decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const editor: AnnotatedEditor = {
      getModel: () => model,
      createDecorationsCollection: () =>
        ({
          set: (next: monaco.editor.IModelDeltaDecoration[]) => {
            decorations = next;
            return [];
          },
          clear: () => {
            decorations = [];
          },
        }) as unknown as monaco.editor.IEditorDecorationsCollection,
      onDidChangeModel: () => ({ dispose: () => undefined }),
      onDidChangeModelContent: () => ({ dispose: () => undefined }),
    };
    const ipc = { fileAt: vi.fn(() => Promise.resolve({ text: "one\ntwo\n" })) } as unknown as FileGitIpc;
    const blameOf = vi.fn(() => Promise.resolve([blame(1, "one", 1), blame(2, "two", 400)]));
    const service = new FileAnnotationsService(
      {
        ipc,
        blame: blameOf,
        pathOf: () => "C:/r/a.ts",
        settings: {
          bool: (id, fallback) => settings[id] ?? fallback,
          number: (_id, fallback) => fallback,
          string: (_id, fallback) => fallback,
        },
        locale: () => "en",
        log: vi.fn(),
      },
      () => NOW,
    );
    return { service, editor, ipc, blameOf, decorations: () => decorations };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  it("does nothing (and runs no Git) while every annotation is off", async () => {
    const { service, editor, ipc, blameOf, decorations } = setup({});
    service.attach(editor);
    await settle();
    expect(decorations()).toEqual([]);
    expect(blameOf).not.toHaveBeenCalled();
    expect(ipc.fileAt).not.toHaveBeenCalled();
  });

  it("maps blame of the saved file onto unsaved edits, and marks the new line as added", async () => {
    const { service, editor, decorations } = setup({
      "git.annotations.blame": true,
      "git.annotations.heatmap": true,
      "git.annotations.changes": true,
    });
    service.attach(editor);
    await settle();
    const blamed = decorations().filter((d) => d.options.after);
    expect(blamed.map((d) => d.range.startLineNumber)).toEqual([1, 3]);
    expect(blamed[0]?.options.after?.content).toContain("Ada, yesterday");
    // The text sits at the line's end; Monaco draws an empty range's text only with showIfCollapsed.
    expect(blamed[0]?.range.startColumn).toBe(4);
    expect(blamed[0]?.options.showIfCollapsed).toBe(true);
    const heat = decorations().filter((d) => d.options.lineNumberClassName);
    expect(heat.map((d) => d.options.lineNumberClassName)).toEqual(["git-heat git-heat--0", "git-heat git-heat--9"]);
    expect(JSON.stringify(heat[1]?.options.hoverMessage)).toContain("a change");
    const added = decorations().find((d) => d.options.linesDecorationsClassName?.includes("added"));
    expect(added?.range.startLineNumber).toBe(2);
  });

  it("stops decorating when its editor goes away", async () => {
    const { service, editor, decorations } = setup({ "git.annotations.changes": true });
    const detach = service.attach(editor);
    await settle();
    expect(decorations().length).toBeGreaterThan(0);
    detach();
    expect(decorations()).toEqual([]);
  });
});
