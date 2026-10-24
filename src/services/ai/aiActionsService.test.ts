import { describe, expect, it, vi } from "vitest";

import { aiRig, providerInfo } from "../../testUtils/aiFixtures";
import type { FilePreviewDoc } from "../filePreviewService";
import { AiActionsService, type AiContextSource } from "./aiActionsService";
import { fenced, previewText } from "./aiContext";

const SELECTION = {
  text: "function add(a, b) { return a + b }",
  languageId: "typescript",
  fileName: "math.ts",
  startLine: 3,
  endLine: 5,
};

function previewDoc(model: FilePreviewDoc["model"], overrides: Partial<FilePreviewDoc> = {}) {
  return {
    id: "pv:1",
    path: "C:/My Files/doc.md",
    name: "doc.md",
    info: null,
    status: "ready",
    error: null,
    model,
    zoomMode: "fit",
    zoom: 1,
    page: 1,
    pageCount: 1,
    sheet: 0,
    dimensions: null,
    loadSeq: 1,
    ...overrides,
  } satisfies FilePreviewDoc;
}

async function setup(
  source: Partial<AiContextSource> = {},
  options: Parameters<typeof aiRig>[0] = {},
) {
  const rig = aiRig({
    providers: [providerInfo({ local: true, needsKey: false, host: "127.0.0.1" })],
    ...options,
  });
  await rig.providers.initialize();
  const full: AiContextSource = {
    activeKind: () => "text",
    selection: () => SELECTION,
    terminalSelection: () => "",
    activePreview: () => null,
    insertAtCursor: vi.fn().mockReturnValue(true),
    ...source,
  };
  const layout = { showView: vi.fn().mockResolvedValue(undefined) };
  const notices: string[] = [];
  rig.events.on("appNotice", ({ message }) => {
    notices.push(message);
  });
  const actions = new AiActionsService(full, rig.chat, layout, rig.events);
  return { rig, actions, layout, notices, source: full };
}

describe("AiActionsService: selected-code actions need a text editor with a selection", () => {
  it("run on the selection with the language, file and lines in the prompt", async () => {
    const { rig, actions, layout } = await setup();
    vi.mocked(rig.ipc.aiChatSend).mockResolvedValue({
      text: "ok",
      cancelled: false,
    });
    for (const kind of ["explain", "fix", "docs"] as const) {
      expect(actions.reason(kind)).toBeNull();
    }
    await actions.run("explain");
    expect(layout.showView).toHaveBeenCalledWith("ai");
    const request = vi.mocked(rig.ipc.aiChatSend).mock.calls[0]?.[2] as {
      messages: { content: string }[];
    };
    expect(request.messages[0]?.content).toContain("typescript code from math.ts (lines 3-5)");
    expect(request.messages[0]?.content).toContain(SELECTION.text);
  });

  it("are refused, with a reason, when a preview tab is in front — it is not an active text editor", async () => {
    const { rig, actions, notices } = await setup({
      activeKind: () => "preview",
      selection: () => null,
    });
    for (const kind of ["explain", "fix", "docs"] as const) {
      expect(actions.reason(kind)).toBe("A preview is not a text editor. Switch to a text file.");
    }
    await actions.run("explain");
    expect(rig.ipc.aiChatSend).not.toHaveBeenCalled();
    expect(notices).toEqual(["A preview is not a text editor. Switch to a text file."]);
  });

  it("say what is missing when no file is open, or nothing is selected", async () => {
    const none = await setup({ activeKind: () => "none", selection: () => null });
    expect(none.actions.reason("explain")).toBe("Open a text file and select some code first.");
    const empty = await setup({ selection: () => null });
    expect(empty.actions.reason("fix")).toBe("Select some code first.");
    const blank = await setup({ selection: () => ({ ...SELECTION, text: "   " }) });
    expect(blank.actions.reason("docs")).toBe("Select some code first.");
  });

  it("allows large selections without a desktop character ceiling", async () => {
    const { actions } = await setup({
      selection: () => ({ ...SELECTION, text: "বাংলা".repeat(40_000) }),
    });
    expect(actions.reason("explain")).toBeNull();
  });

  it("go through the confirmation for an online provider and name what is sent", async () => {
    const { rig, actions } = await setup({}, { providers: [providerInfo()] });
    await actions.run("explain");
    expect(rig.ipc.aiChatSend).not.toHaveBeenCalled();
    expect(rig.chat.getState().confirmation).toMatchObject({
      providerName: "Mock AI",
      host: "api.example.com",
      what: "the selected code",
    });
  });
});

describe("AiActionsService: terminal output and previews", () => {
  it("explain terminal error only with selected output", async () => {
    const empty = await setup();
    expect(empty.actions.reason("terminal")).toBe("Select the terminal output to explain first.");
    const selected = await setup({ terminalSelection: () => "error: cannot find module 'x'" });
    expect(selected.actions.reason("terminal")).toBeNull();
    vi.mocked(selected.rig.ipc.aiChatSend).mockResolvedValue({
      text: "ok",
      cancelled: false,
    });
    await selected.actions.run("terminal");
    const request = vi.mocked(selected.rig.ipc.aiChatSend).mock.calls[0]?.[2] as {
      messages: { content: string }[];
    };
    expect(request.messages[0]?.content).toContain("cannot find module 'x'");
  });

  it("summarize a preview only when it holds text, and say why not otherwise", async () => {
    const markdown = await setup({
      activeKind: () => "preview",
      activePreview: () => previewDoc({ type: "markdown", text: "# Title\n\nSome words." }),
    });
    expect(markdown.actions.reason("preview")).toBeNull();
    vi.mocked(markdown.rig.ipc.aiChatSend).mockResolvedValue({
      text: "ok",
      cancelled: false,
    });
    await markdown.actions.run("preview");
    const request = vi.mocked(markdown.rig.ipc.aiChatSend).mock.calls[0]?.[2] as {
      messages: { content: string }[];
    };
    expect(request.messages[0]?.content).toContain('Summarize this markdown document "doc.md"');
    expect(request.messages[0]?.content).toContain("Some words.");

    const image = await setup({
      activeKind: () => "preview",
      activePreview: () =>
        previewDoc({
          type: "image",
          dataUrl: "data:image/png;base64,AAAA",
          mime: "image/png",
          notice: null,
        }),
    });
    expect(image.actions.reason("preview")).toContain("never sent");
    await image.actions.run("preview");
    expect(image.rig.ipc.aiChatSend).not.toHaveBeenCalled();

    const none = await setup();
    expect(none.actions.reason("preview")).toBe("Open a file preview first.");
    const loading = await setup({
      activePreview: () => previewDoc(null, { status: "loading" }),
    });
    expect(loading.actions.reason("preview")).toBe("The preview is not loaded yet.");
  });

  it("extracts text from csv, docx and latex previews, and never from spreadsheets or messages", () => {
    expect(
      previewText(
        previewDoc({
          type: "csv",
          table: {
            rows: [
              ["a", "b"],
              ["1", "2"],
            ],
            delimiter: ",",
            totalRows: 2,
            totalCols: 2,
            truncatedRows: false,
            truncatedCols: false,
          },
          partialFile: false,
        }),
      ).text,
    ).toBe("a, b\n1, 2");
    expect(
      previewText(
        previewDoc({
          type: "docx",
          docx: {
            blocks: [
              { type: "paragraph", text: "Hello", heading: 1, list: false },
              { type: "table", rows: [["x", "y"]] },
            ],
            metadata: { title: null, author: null, created: null, modified: null },
            imageCount: 0,
            hasMacros: false,
            truncated: false,
          },
        }),
      ).text,
    ).toBe("Hello\nx | y");
    expect(
      previewText(
        previewDoc({
          type: "latex",
          outline: { blocks: [{ kind: "title", text: "Paper" }], truncated: false },
        }),
      ).text,
    ).toBe("Paper");
    expect(previewText(previewDoc({ type: "message", message: "binary" })).reason).toBe(
      "This preview has no text to summarize.",
    );
    expect(previewText(previewDoc({ type: "pdf", bytes: new Uint8Array() })).text).toBeNull();
  });
});

describe("AiActionsService: inserting an answer", () => {
  it("inserts only into a text editor and only when asked", async () => {
    const { actions, source, notices } = await setup();
    expect(actions.insertReason()).toBeNull();
    expect(actions.insert("code")).toBe(true);
    expect(source.insertAtCursor).toHaveBeenCalledWith("code");

    const preview = await setup({ activeKind: () => "preview" });
    expect(preview.actions.insertReason()).toBe(
      "A preview can't be edited. Switch to a text file.",
    );
    expect(preview.actions.insert("code")).toBe(false);
    expect(preview.source.insertAtCursor).not.toHaveBeenCalled();
    expect(preview.notices).toEqual(["A preview can't be edited. Switch to a text file."]);
    expect(notices).toEqual([]);
  });
});

describe("fenced", () => {
  it("uses a longer fence when the text contains one", () => {
    expect(fenced("a\n```\nb", "md")).toBe("````md\na\n```\nb\n````");
    expect(fenced("x", "ts")).toBe("```ts\nx\n```");
  });
});

