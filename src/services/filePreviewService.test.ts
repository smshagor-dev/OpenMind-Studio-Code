import { describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import {
  FilePreviewService,
  ZOOM_STEPS,
  isPreviewableText,
  kindOfPath,
  type FilePreviewDoc,
} from "./filePreviewService";
import type { PreviewInspection } from "./previewIpc";

function info(path: string, extra: Partial<PreviewInspection> = {}): PreviewInspection {
  const name = path.split(/[\\/]/).pop() ?? path;
  return {
    path,
    name,
    size: 1234,
    kind: kindOfPath(path),
    binary: false,
    tooLarge: false,
    limit: 1_000_000,
    textSafe: false,
    ...extra,
  };
}

/** Lets pending loads (a few awaited IPC calls) finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function rig(overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const ipc = createFakeIpc({
    previewInspect: vi.fn((path: string) => Promise.resolve(info(path))),
    ...overrides,
  });
  const service = new FilePreviewService(ipc);
  const open = async (path: string): Promise<FilePreviewDoc> => {
    const id = service.open(path);
    await settle();
    const doc = service.get(id);
    if (!doc) throw new Error("no doc");
    return doc;
  };
  return { ipc, service, open };
}

describe("file type routing", () => {
  it("maps every supported extension, case-insensitively, and only text formats are previewable text", () => {
    for (const [name, kind] of [
      ["a.PNG", "image"],
      ["a.jpg", "image"],
      ["a.jpeg", "image"],
      ["a.webp", "image"],
      ["a.gif", "image"],
      ["a.bmp", "image"],
      ["a.svg", "image"],
      ["a.pdf", "pdf"],
      ["a.docx", "docx"],
      ["a.xlsx", "xlsx"],
      ["a.csv", "csv"],
      ["a.md", "markdown"],
      ["a.markdown", "markdown"],
      ["a.html", "html"],
      ["a.htm", "html"],
      ["a.tex", "latex"],
      ["a.rs", "unsupported"],
      ["noext", "unsupported"],
    ] as const) {
      expect(kindOfPath(`C:\\My Site\\${name}`), name).toBe(kind);
    }
    expect(isPreviewableText("a.md")).toBe(true);
    expect(isPreviewableText("a.csv")).toBe(true);
    expect(isPreviewableText("a.png")).toBe(false);
    expect(isPreviewableText("a.docx")).toBe(false);
  });

  it("images, PDF, DOCX and XLSX preview directly; text and code open as text; binary and oversized files preview", async () => {
    const inspect = vi.fn((path: string) =>
      Promise.resolve(
        info(path, {
          binary: path.endsWith(".bin") || path.endsWith("fake.md"),
          tooLarge: path.endsWith("huge.log") || path.endsWith("huge.md"),
        }),
      ),
    );
    const { service } = rig({ previewInspect: inspect });
    for (const path of ["a.png", "a.pdf", "a.docx", "a.xlsx"]) {
      expect(await service.shouldPreview(path), path).toBe(true);
    }
    expect(inspect).not.toHaveBeenCalled(); // decided by the extension alone
    for (const path of ["a.md", "a.html", "a.tex", "a.csv", "a.rs", "notes.xyz"]) {
      expect(await service.shouldPreview(path), path).toBe(false);
    }
    expect(await service.shouldPreview("data.bin")).toBe(true);
    expect(await service.shouldPreview("fake.md")).toBe(true); // a .md that is really binary
    expect(await service.shouldPreview("huge.log")).toBe(true); // too big for the editor
    expect(await service.shouldPreview("huge.md")).toBe(true);
    inspect.mockRejectedValueOnce(new Error("gone"));
    expect(await service.shouldPreview("gone.xyz")).toBe(false);
  });
});

describe("FilePreviewService models", () => {
  it("an image becomes a data address with its type, and a plain SVG has no notice", async () => {
    const { service, open } = rig({ previewReadBytes: vi.fn().mockResolvedValue("iVBORw0KGgo=") });
    const doc = await open("C:/My Site/a.png");
    expect(doc.status).toBe("ready");
    expect(doc.model).toMatchObject({
      type: "image",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      notice: null,
    });
    expect(service.has(doc.id)).toBe(true);
  });

  it("an SVG with a script is still only an image, with a notice that nothing runs", async () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const { open } = rig({ previewReadBytes: vi.fn().mockResolvedValue(svg) });
    const doc = await open("C:/evil.svg");
    expect(doc.model).toMatchObject({ type: "image", mime: "image/svg+xml" });
    if (doc.model?.type !== "image") throw new Error("not an image");
    expect(doc.model.dataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(doc.model.notice).toContain("scripts");
    expect(doc.model.notice).toContain("scripts do not run");
  });

  it("a PDF becomes bytes; DOCX and XLSX come from their backend models", async () => {
    const docx = {
      blocks: [],
      metadata: { title: null, author: null, created: null, modified: null },
      imageCount: 0,
      hasMacros: false,
      truncated: false,
    };
    const xlsx = {
      sheets: ["A"],
      selected: 0,
      hasMacros: false,
      sheet: {
        name: "A",
        rows: [["1"]],
        totalRows: 1,
        totalCols: 1,
        truncatedRows: false,
        truncatedCols: false,
      },
    };
    const { open } = rig({
      previewReadBytes: vi.fn().mockResolvedValue(btoa("%PDF-1.4")),
      previewDocx: vi.fn().mockResolvedValue(docx),
      previewXlsx: vi.fn().mockResolvedValue(xlsx),
    });
    const pdf = await open("C:/a.pdf");
    expect(pdf.model?.type === "pdf" && new TextDecoder().decode(pdf.model.bytes)).toBe("%PDF-1.4");
    expect((await open("C:/a.docx")).model).toEqual({ type: "docx", docx });
    expect((await open("C:/a.xlsx")).model).toEqual({ type: "xlsx", xlsx });
  });

  it("switching sheets asks the backend for that sheet and keeps the rest", async () => {
    const previewXlsx = vi.fn((_path: string, sheet: number) =>
      Promise.resolve({
        sheets: ["One", "Two"],
        selected: sheet,
        hasMacros: false,
        sheet: {
          name: ["One", "Two"][sheet] ?? "",
          rows: [[String(sheet)]],
          totalRows: 1,
          totalCols: 1,
          truncatedRows: false,
          truncatedCols: false,
        },
      }),
    );
    const { service, open } = rig({ previewXlsx });
    const doc = await open("C:/book.xlsx");
    await service.setSheet(doc.id, 1);
    expect(previewXlsx).toHaveBeenLastCalledWith("C:/book.xlsx", 1);
    const after = service.get(doc.id)?.model;
    expect(after?.type === "xlsx" && after.xlsx.sheet.name).toBe("Two");
  });

  it("a CSV becomes a table, and a cut file is marked partial", async () => {
    const { open } = rig({
      previewReadText: vi.fn().mockResolvedValue({ text: "a,b\n1,2\n", truncated: true }),
    });
    const doc = await open("C:/data.csv");
    expect(doc.model).toMatchObject({
      type: "csv",
      partialFile: true,
      table: {
        rows: [
          ["a", "b"],
          ["1", "2"],
        ],
        delimiter: ",",
        totalRows: 2,
      },
    });
  });

  it("Markdown and HTML keep their text; LaTeX is outlined, never compiled", async () => {
    const texts: Record<string, string> = {
      "C:/a.md": "# Hi",
      "C:/a.html": "<p>x</p>",
      "C:/a.tex": "\\section{One}",
    };
    const { open } = rig({
      previewReadText: vi.fn((path: string) =>
        Promise.resolve({ text: texts[path] ?? "", truncated: false }),
      ),
    });
    expect((await open("C:/a.md")).model).toEqual({ type: "markdown", text: "# Hi" });
    expect((await open("C:/a.html")).model).toEqual({ type: "html", text: "<p>x</p>" });
    expect((await open("C:/a.tex")).model).toMatchObject({
      type: "latex",
      outline: { blocks: [{ kind: "section", level: 1, text: "One" }] },
    });
  });

  it("an unsupported file, a binary file and a file over its limit show a message, not a viewer", async () => {
    const inspect = vi.fn((path: string) => {
      if (path.endsWith(".bin")) return Promise.resolve(info(path, { binary: true }));
      if (path.endsWith(".png")) {
        return Promise.resolve(
          info(path, { tooLarge: true, size: 20 * 1024 * 1024, limit: 15 * 1024 * 1024 }),
        );
      }
      return Promise.resolve(info(path));
    });
    const { ipc, open } = rig({ previewInspect: inspect });
    const binary = await open("C:/x.bin");
    expect(binary.model).toEqual({
      type: "message",
      message: "This file appears to be binary and cannot be previewed safely.",
    });
    expect((await open("C:/x.xyz")).model).toEqual({
      type: "message",
      message: "Preview not available for this file type.",
    });
    const big = await open("C:/big.png");
    expect(big.model?.type === "message" && big.model.message).toContain("preview limit");
    expect(ipc.previewReadBytes).not.toHaveBeenCalled(); // never read
  });

  it("an oversized plain-text file (not binary) is refused with its size instead of being loaded", async () => {
    const { ipc, open } = rig({
      previewInspect: vi.fn((path: string) =>
        Promise.resolve(
          info(path, { tooLarge: true, size: 60 * 1024 * 1024, limit: 10 * 1024 * 1024 }),
        ),
      ),
    });
    const doc = await open("C:/logs/huge.log");
    expect(doc.model).toMatchObject({ type: "message" });
    expect(doc.model?.type === "message" && doc.model.message).toContain("60.0 MB");
    expect(ipc.previewReadText).not.toHaveBeenCalled();
  });

  it("a backend failure (malformed, encrypted, too large, missing) is the error state with its message", async () => {
    const { ipc, service, open } = rig({
      previewDocx: vi.fn().mockRejectedValue("The document XML is malformed: bad"),
    });
    const doc = await open("C:/bad.docx");
    expect(doc.status).toBe("error");
    expect(doc.error).toBe("The document XML is malformed: bad");
    expect(doc.model).toBeNull();
    // Reload tries again and can recover.
    vi.mocked(ipc.previewDocx).mockResolvedValueOnce({
      blocks: [],
      metadata: { title: null, author: null, created: null, modified: null },
      imageCount: 0,
      hasMacros: false,
      truncated: false,
    });
    await service.reload(doc.id);
    expect(service.get(doc.id)?.status).toBe("ready");
  });

  it("one document per path (any slash style or case), released when closed", async () => {
    const { service, open } = rig();
    const first = await open("C:\\My Site\\A.png");
    expect(service.open("c:/my site/a.PNG")).toBe(first.id);
    service.release(first.id);
    expect(service.has(first.id)).toBe(false);
    expect(service.open("C:\\My Site\\A.png")).not.toBe(first.id);
  });

  it("a stale load never overwrites a newer one", async () => {
    let releaseFirst: (value: PreviewInspection) => void = () => undefined;
    const inspect = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PreviewInspection>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockImplementation((path: string) => Promise.resolve(info(path)));
    const { service } = rig({
      previewInspect: inspect,
      previewReadText: vi.fn().mockResolvedValue({ text: "new", truncated: false }),
    });
    const id = service.open("C:/a.md");
    await service.reload(id);
    releaseFirst(info("C:/a.md"));
    await settle();
    expect(service.get(id)?.model).toEqual({ type: "markdown", text: "new" });
  });
});

describe("zoom, pages and dimensions", () => {
  it("zoom steps through the levels from Fit, Actual Size resets, and only images and PDFs zoom", async () => {
    const { service, open } = rig({ previewReadBytes: vi.fn().mockResolvedValue("AAAA") });
    const doc = await open("C:/a.png");
    expect(doc.zoomMode).toBe("fit");
    service.zoomIn(doc.id);
    expect(service.get(doc.id)).toMatchObject({ zoomMode: "zoom", zoom: 1.25 });
    service.zoomIn(doc.id);
    expect(service.get(doc.id)?.zoom).toBe(1.5);
    service.zoomOut(doc.id);
    service.zoomOut(doc.id);
    service.zoomOut(doc.id);
    expect(service.get(doc.id)?.zoom).toBe(0.75);
    service.actualSize(doc.id);
    expect(service.get(doc.id)).toMatchObject({ zoomMode: "actual", zoom: 1 });
    service.fit(doc.id);
    expect(service.get(doc.id)?.zoomMode).toBe("fit");
    for (let i = 0; i < 30; i += 1) service.zoomIn(doc.id);
    expect(service.get(doc.id)?.zoom).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    for (let i = 0; i < 30; i += 1) service.zoomOut(doc.id);
    expect(service.get(doc.id)?.zoom).toBe(ZOOM_STEPS[0]);
  });

  it("zoom does nothing for a document that isn't an image or PDF", async () => {
    const { service, open } = rig({
      previewReadText: vi.fn().mockResolvedValue({ text: "# x", truncated: false }),
    });
    const doc = await open("C:/a.md");
    expect(service.zoomable(doc.id)).toBe(false);
    service.zoomIn(doc.id);
    expect(service.get(doc.id)?.zoomMode).toBe("fit");
  });

  it("pages stay inside 1..count and dimensions are remembered", async () => {
    const { service, open } = rig({ previewReadBytes: vi.fn().mockResolvedValue("AAAA") });
    const doc = await open("C:/a.pdf");
    service.setPage(doc.id, 3); // count unknown yet: ignored
    expect(service.get(doc.id)?.page).toBe(1);
    service.setPageCount(doc.id, 5);
    service.setPage(doc.id, 99);
    expect(service.get(doc.id)?.page).toBe(5);
    service.setPage(doc.id, -4);
    expect(service.get(doc.id)?.page).toBe(1);
    service.setDimensions(doc.id, 640, 480);
    expect(service.get(doc.id)?.dimensions).toEqual({ width: 640, height: 480 });
  });
});
