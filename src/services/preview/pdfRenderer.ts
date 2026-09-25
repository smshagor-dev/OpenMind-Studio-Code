import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

/** One PDF page's size in CSS pixels at scale 1. */
export interface PdfPageSize {
  width: number;
  height: number;
}

/** A loaded PDF: page count, page sizes and rendering into a canvas. Everything runs in this window, offline. */
export interface PdfHandle {
  pageCount: number;
  pageSize: (page: number) => Promise<PdfPageSize>;
  render: (page: number, canvas: HTMLCanvasElement, scale: number) => Promise<void>;
  destroy: () => void;
}

export type PdfLoader = (bytes: Uint8Array) => Promise<PdfHandle>;

/** Why a PDF could not be opened, as a sentence for the user. */
export function pdfErrorMessage(error: unknown): string {
  const name =
    typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  if (name === "PasswordException") {
    return "This PDF is encrypted (password-protected) and can't be previewed.";
  }
  if (name === "InvalidPDFException" || name === "FormatError") {
    return "This file isn't a valid PDF, or it is damaged.";
  }
  if (name === "MissingPDFException") return "The PDF file is missing.";
  return `The PDF couldn't be shown: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Loads a PDF with pdf.js from the app's own files (the worker, fonts and character maps are copied next to the
 * app by `scripts/copy-pdf-assets.mjs`): no network, no script execution (pdf.js's scripting is off), no forms, no annotations editing.
 */
export const loadPdf: PdfLoader = async (bytes) => {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf/pdf.worker.min.mjs";
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: "/pdf/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdf/standard_fonts/",
    wasmUrl: "/pdf/wasm/",
    iccUrl: "/pdf/iccs/",
    verbosity: 0,
  });
  let document: PDFDocumentProxy;
  try {
    document = await task.promise;
  } catch (error) {
    void task.destroy();
    throw error;
  }
  let running: RenderTask | null = null;
  return {
    pageCount: document.numPages,
    pageSize: async (page) => {
      const view = (await document.getPage(page)).getViewport({ scale: 1 });
      return { width: view.width, height: view.height };
    },
    render: async (page, canvas, scale) => {
      running?.cancel();
      const loaded = await document.getPage(page);
      const ratio = window.devicePixelRatio || 1;
      const viewport = loaded.getViewport({ scale: scale * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${String(Math.floor(viewport.width / ratio))}px`;
      canvas.style.height = `${String(Math.floor(viewport.height / ratio))}px`;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This window can't draw PDF pages.");
      const render = loaded.render({ canvas, canvasContext: context, viewport });
      running = render;
      try {
        await render.promise;
      } finally {
        if (running === render) running = null;
      }
    },
    destroy: () => {
      running?.cancel();
      void task.destroy();
    },
  };
};
