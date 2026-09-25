import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIpc } from "../testUtils/fakeIpcClient";
import { FilePreviewService, kindOfPath } from "../services/filePreviewService";
import type { PdfHandle } from "../services/preview/pdfRenderer";
import type { PreviewInspection } from "../services/previewIpc";

const harness = vi.hoisted(
  (): { container: unknown; loadPdf: (bytes: Uint8Array) => Promise<unknown> } => ({
    container: null,
    loadPdf: () => Promise.reject(new Error("not set")),
  }),
);

vi.mock("../services/container", () => ({
  get container() {
    return harness.container;
  },
}));

vi.mock("../services/preview/pdfRenderer", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/preview/pdfRenderer")>();
  return { ...original, loadPdf: (bytes: Uint8Array) => harness.loadPdf(bytes) };
});

import { FilePreviewView } from "./FilePreviewView";

function info(path: string, extra: Partial<PreviewInspection> = {}): PreviewInspection {
  return {
    path,
    name: path.split("/").pop() ?? path,
    size: 2048,
    kind: kindOfPath(path),
    binary: false,
    tooLarge: false,
    limit: 1_000_000,
    textSafe: false,
    ...extra,
  };
}

function mount(path: string, overrides: Parameters<typeof createFakeIpc>[0] = {}) {
  const ipc = createFakeIpc({
    previewInspect: vi.fn((p: string) => Promise.resolve(info(p))),
    ...overrides,
  });
  const filePreviews = new FilePreviewService(ipc);
  const openAsText = vi.fn().mockResolvedValue(true);
  const followLink = vi.fn().mockResolvedValue(undefined);
  harness.container = {
    filePreviews,
    workspace: { openAsText },
    markdown: { followLink },
  };
  const id = filePreviews.open(path);
  render(<FilePreviewView docId={id} />);
  return { ipc, filePreviews, id, openAsText, followLink };
}

function pdfHandle(pages: number): PdfHandle & { render: ReturnType<typeof vi.fn> } {
  return {
    pageCount: pages,
    pageSize: vi.fn().mockResolvedValue({ width: 600, height: 800 }),
    render: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  };
}

beforeEach(() => {
  harness.container = null;
  harness.loadPdf = () => Promise.reject(new Error("not set"));
});

describe("FilePreviewView: the frame", () => {
  it("shows the name (full path in the tooltip), type, size, a read-only badge, Reload and no Save", async () => {
    mount("C:/My Site/notes.tex", {
      previewReadText: vi.fn().mockResolvedValue({ text: "\\section{A}", truncated: false }),
    });
    const name = await screen.findByText("notes.tex");
    expect(name.getAttribute("title")).toBe("C:/My Site/notes.tex");
    expect(await screen.findByText(/LaTeX source · 2.0 KB/)).toBeTruthy();
    expect(screen.getByText("Read-only preview")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload Preview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("Reload Preview reads the file again", async () => {
    const readText = vi.fn().mockResolvedValue({ text: "# One", truncated: false });
    const { ipc } = mount("C:/a.md", { previewReadText: readText });
    await screen.findByRole("heading", { name: "One" });
    readText.mockResolvedValue({ text: "# Two", truncated: false });
    fireEvent.click(screen.getByRole("button", { name: "Reload Preview" }));
    await screen.findByRole("heading", { name: "Two" });
    expect(ipc.previewInspect).toHaveBeenCalledTimes(2);
  });

  it("Open as Text is disabled with its reason for a binary file and calls the workspace for a safe one", async () => {
    mount("C:/a.png", { previewReadBytes: vi.fn().mockResolvedValue("AAAA") });
    const disabled = await screen.findByRole("button", { name: "Open as Text" });
    await waitFor(() => {
      expect(screen.getByText(/Image · 2.0 KB/)).toBeTruthy();
    });
    expect((disabled as HTMLButtonElement).disabled).toBe(true);
    expect(disabled.getAttribute("title")).toContain("isn't text");
  });

  it("Open as Text works for a text format", async () => {
    const { openAsText, id } = mount("C:/a.md", {
      previewInspect: vi.fn((p: string) => Promise.resolve(info(p, { textSafe: true }))),
      previewReadText: vi.fn().mockResolvedValue({ text: "hi", truncated: false }),
    });
    await screen.findByText("hi");
    fireEvent.click(screen.getByRole("button", { name: "Open as Text" }));
    expect(openAsText).toHaveBeenCalledWith(id);
  });

  it("a failed preview shows its message as an alert, never a blank tab", async () => {
    mount("C:/bad.docx", {
      previewDocx: vi.fn().mockRejectedValue("The document XML is malformed: x"),
    });
    expect((await screen.findByRole("alert")).textContent).toBe("The document XML is malformed: x");
  });
});

describe("FilePreviewView: images", () => {
  function setup(path = "C:/a.png", data = "AAAA") {
    return mount(path, { previewReadBytes: vi.fn().mockResolvedValue(data) });
  }

  it("zoom, fit and actual size drive the label and the image size; dimensions come from the decoded image", async () => {
    const { filePreviews, id } = setup();
    const image = await screen.findByRole("img", { name: "a.png" });
    expect(document.querySelector(".file-preview__zoom")?.textContent).toBe("Fit");
    Object.defineProperty(image, "naturalWidth", { value: 400, configurable: true });
    Object.defineProperty(image, "naturalHeight", { value: 300, configurable: true });
    fireEvent.load(image);
    expect(await screen.findByText(/400 × 300 px/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    expect(screen.getByText("125%")).toBeTruthy();
    expect(image.style.width).toBe("500px");
    fireEvent.click(screen.getByRole("button", { name: "Zoom Out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom Out" }));
    expect(screen.getByText("75%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Actual Size" }));
    expect(screen.getByText("100%")).toBeTruthy();
    expect(image.style.maxWidth).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Fit to Screen" }));
    expect(document.querySelector(".file-preview__zoom")?.textContent).toBe("Fit");
    expect(filePreviews.get(id)?.zoomMode).toBe("fit");
  });

  it("an SVG with a script shows the notice and is drawn only as an <img> data address", async () => {
    setup("C:/evil.svg", btoa("<svg><script>alert(1)</script></svg>"));
    const image = await screen.findByRole("img", { name: "evil.svg" });
    expect((await screen.findByRole("status")).textContent).toContain("scripts do not run");
    expect(image.getAttribute("src")?.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(document.querySelector("script")).toBeNull();
  });

  it("an image that can't be decoded says so", async () => {
    setup();
    fireEvent.error(await screen.findByRole("img", { name: "a.png" }));
    expect((await screen.findByRole("alert")).textContent).toContain("couldn't be decoded");
  });
});

describe("FilePreviewView: PDF", () => {
  it("shows page x of n, moves between pages, stops at the ends and zooms", async () => {
    const handle = pdfHandle(3);
    harness.loadPdf = () => Promise.resolve(handle);
    mount("C:/a.pdf", { previewReadBytes: vi.fn().mockResolvedValue(btoa("%PDF-1.4")) });
    await screen.findByText("/ 3");
    const input = screen.getByRole("spinbutton", { name: "Page number" });
    expect((input as HTMLInputElement).value).toBe("1");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Previous Page" }).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next Page" }));
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe("2");
    });
    fireEvent.click(screen.getByRole("button", { name: "Next Page" }));
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next Page" }).disabled).toBe(
        true,
      );
    });
    fireEvent.change(input, { target: { value: "1" } });
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe("1");
    });
    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    expect(screen.getByText("125%")).toBeTruthy();
    await waitFor(() => {
      const scales = handle.render.mock.calls.map((call) => call[2] as number);
      expect(scales).toContain(1.25);
    });
    // Every draw is of the page the toolbar shows.
    expect(handle.render.mock.calls.some((call) => call[0] === 3)).toBe(true);
  });

  it("an encrypted PDF and a damaged PDF give clear errors", async () => {
    harness.loadPdf = () =>
      Promise.reject(Object.assign(new Error("x"), { name: "PasswordException" }));
    mount("C:/locked.pdf", { previewReadBytes: vi.fn().mockResolvedValue(btoa("%PDF")) });
    expect((await screen.findByRole("alert")).textContent).toContain("encrypted");
  });

  it("a malformed PDF is reported, not a crash", async () => {
    harness.loadPdf = () =>
      Promise.reject(
        Object.assign(new Error("Invalid PDF structure"), { name: "InvalidPDFException" }),
      );
    mount("C:/broken.pdf", { previewReadBytes: vi.fn().mockResolvedValue(btoa("garbage")) });
    expect((await screen.findByRole("alert")).textContent).toContain("isn't a valid PDF");
  });
});

describe("FilePreviewView: documents and spreadsheets", () => {
  it("DOCX shows the limitation, headings, list items, tables and the macro and image notes", async () => {
    mount("C:/report.docx", {
      previewDocx: vi.fn().mockResolvedValue({
        blocks: [
          { type: "paragraph", text: "Quarterly report", heading: 1, list: false },
          { type: "paragraph", text: "Plain text", heading: null, list: false },
          { type: "paragraph", text: "first point", heading: null, list: true },
          { type: "table", rows: [["A1", "B1"]] },
          { type: "paragraph", text: "<script>alert(1)</script>", heading: null, list: false },
        ],
        metadata: { title: "Report", author: "Ann", created: null, modified: null },
        imageCount: 2,
        hasMacros: true,
        truncated: false,
      }),
    });
    expect(
      await screen.findByText(
        "This DOCX preview is read-only and may not exactly match Microsoft Word layout.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Quarterly report" })).toBeTruthy();
    expect(screen.getByText("• first point")).toBeTruthy();
    expect(screen.getByText("B1")).toBeTruthy();
    expect(screen.getByText(/Macros are never run/)).toBeTruthy();
    expect(screen.getByText(/2 embedded images are not shown/)).toBeTruthy();
    expect(screen.getByText(/Author: Ann/)).toBeTruthy();
    // Document text is shown as text, never as markup.
    expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  });

  it("XLSX shows the limitation, the sheet list, a grid, the counts, and loads another sheet on click", async () => {
    const model = (selected: number) => ({
      sheets: ["Data", "Other"],
      selected,
      hasMacros: false,
      sheet: {
        name: selected === 0 ? "Data" : "Other",
        rows:
          selected === 0
            ? [
                ["Name", "Qty"],
                ["Bolt", "=SUM(B2:B9)"],
              ]
            : [["Only"]],
        totalRows: selected === 0 ? 2500 : 1,
        totalCols: selected === 0 ? 2 : 1,
        truncatedRows: selected === 0,
        truncatedCols: false,
      },
    });
    const previewXlsx = vi.fn((_path: string, sheet: number) => Promise.resolve(model(sheet)));
    mount("C:/book.xlsx", { previewXlsx });
    expect(
      await screen.findByText(
        "This spreadsheet preview is read-only and does not evaluate formulas or macros.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("=SUM(B2:B9)")).toBeTruthy();
    expect(screen.getByText("2500 rows × 2 columns")).toBeTruthy();
    expect(screen.getByText(/Showing the first 2 rows/)).toBeTruthy();
    const tabs = screen.getByRole("tablist", { name: "Sheets" });
    expect(within(tabs).getByRole("tab", { name: "Data" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.click(within(tabs).getByRole("tab", { name: "Other" }));
    await screen.findByText("Only");
    expect(previewXlsx).toHaveBeenLastCalledWith("C:/book.xlsx", 1);
    expect(within(tabs).getByRole("tab", { name: "Other" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("CSV shows counts, the delimiter and the row-limit message; a big file says it is partial", async () => {
    const text = Array.from({ length: 1500 }, (_, n) => `${String(n)};v`).join("\n");
    mount("C:/big.csv", {
      previewReadText: vi.fn().mockResolvedValue({ text, truncated: true }),
    });
    expect(await screen.findByText(/1500 rows × 2 columns \(partial\)/)).toBeTruthy();
    expect(screen.getByText("Delimiter: ;")).toBeTruthy();
    expect(screen.getByText(/Showing the first 1000 of 1500 rows/)).toBeTruthy();
    expect(screen.getByText(/only its first part was read/)).toBeTruthy();
    expect(screen.getAllByRole("row").length).toBeLessThan(1100);
  });
});

describe("FilePreviewView: markup", () => {
  it("Markdown renders headings, code, tables and links as elements; raw HTML and scripts stay text", async () => {
    const md = [
      "# Title",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```js",
      "let x = 1;",
      "```",
      "",
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(2)">',
      "",
      "[safe](https://example.com) [bad](javascript:alert(3)) [rel](other.md)",
    ].join("\n");
    const { followLink, id } = mount("C:/My Site/read me.md", {
      previewReadText: vi.fn().mockResolvedValue({ text: md, truncated: false }),
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Title" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("let x = 1;")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("<script>alert(1)</script>");
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "rel" }));
    expect(followLink).toHaveBeenCalledWith(id, "other.md");
    fireEvent.click(screen.getByRole("link", { name: "safe" }));
    expect(followLink).toHaveBeenCalledWith(id, "https://example.com");
  });

  it("HTML is shown in a frame with an empty sandbox, without scripts, handlers or remote content, with a notice", async () => {
    const html = [
      "<h1>Page</h1>",
      "<script>window.parent.x = 1</script>",
      '<p onclick="steal()">click</p>',
      '<a href="javascript:alert(1)">bad</a>',
      '<img src="https://evil.test/track.png">',
      '<iframe src="https://evil.test"></iframe>',
      '<link rel="stylesheet" href="https://evil.test/a.css">',
    ].join("");
    mount("C:/page.html", {
      previewReadText: vi.fn().mockResolvedValue({ text: html, truncated: false }),
    });
    const frame = await screen.findByTitle("HTML preview");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const doc = frame.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("<h1>Page</h1>");
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/onclick/i);
    expect(doc).not.toMatch(/<iframe/i);
    expect(doc).not.toMatch(/javascript:/i);
    expect(doc).not.toContain("https://evil.test/track.png");
    expect(doc).not.toContain("https://evil.test/a.css");
    expect(doc).toContain("Content-Security-Policy");
    const notices = screen.getByRole("status").textContent;
    expect(notices).toContain("1 script blocked");
    expect(notices).toContain("1 inline event handler blocked");
    expect(notices).toContain("Remote content blocked");
    expect(screen.getByText(/Scripts and remote content are always blocked/)).toBeTruthy();
  });

  it("LaTeX shows the not-compiled message and the structure", async () => {
    mount("C:/paper.tex", {
      previewReadText: vi.fn().mockResolvedValue({
        text: "\\title{Big Idea}\n\\section{Intro}\nText here.\n\\begin{equation}\nx=1\n\\end{equation}\n\\bibliography{refs}",
        truncated: false,
      }),
    });
    expect(
      await screen.findByText(
        "LaTeX compilation preview is not available yet. This is a read-only source preview.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Big Idea" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Intro" })).toBeTruthy();
    expect(screen.getByLabelText("Equation source").textContent).toBe("x=1");
    expect(screen.getByText("\\bibliography{refs}")).toBeTruthy();
  });
});

describe("FilePreviewView: unsupported, binary and large files", () => {
  it("an unsupported file says no preview is available and has no viewer controls", async () => {
    mount("C:/notes.xyz");
    expect(await screen.findByText("Preview not available for this file type.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Zoom In" })).toBeNull();
  });

  it("a binary file says it can't be previewed safely and offers no Open as Text", async () => {
    mount("C:/data.bin", {
      previewInspect: vi.fn((p: string) => Promise.resolve(info(p, { binary: true }))),
    });
    expect(
      await screen.findByText("This file appears to be binary and cannot be previewed safely."),
    ).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Open as Text" }).disabled).toBe(
      true,
    );
  });

  it("a file over its limit is refused with the sizes, and its bytes are never read", async () => {
    const readBytes = vi.fn();
    mount("C:/huge.png", {
      previewInspect: vi.fn((p: string) =>
        Promise.resolve(
          info(p, { tooLarge: true, size: 20 * 1024 * 1024, limit: 15 * 1024 * 1024 }),
        ),
      ),
      previewReadBytes: readBytes,
    });
    expect(await screen.findByText(/20.0 MB, more than the 15.0 MB preview limit/)).toBeTruthy();
    expect(readBytes).not.toHaveBeenCalled();
  });
});
