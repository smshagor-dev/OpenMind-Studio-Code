import { useEffect, useRef, useState } from "react";

import { container } from "../../services/container";
import type { FilePreviewDoc } from "../../services/filePreviewService";
import { loadPdf, pdfErrorMessage, type PdfHandle } from "../../services/preview/pdfRenderer";

/**
 * One PDF page at a time, drawn by pdf.js from the app's own files. Page and zoom live in `FilePreviewService`
 * (so the toolbar and the commands drive them); this view loads the document, measures the pane for Fit Width and
 * draws the current page. A password-protected or damaged PDF shows a clear message instead.
 */
export function PdfPreview({ doc, bytes }: { doc: FilePreviewDoc; bytes: Uint8Array }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const pane = useRef<HTMLDivElement | null>(null);
  const handle = useRef<PdfHandle | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [failure, setFailure] = useState<{ bytes: Uint8Array; message: string } | null>(null);
  const error = failure?.bytes === bytes ? failure.message : null;
  const [width, setWidth] = useState(0);
  const { id, page, zoom, zoomMode } = doc;

  useEffect(() => {
    let cancelled = false;
    loadPdf(bytes)
      .then((pdf) => {
        if (cancelled) {
          pdf.destroy();
          return;
        }
        handle.current = pdf;
        container.filePreviews.setPageCount(id, pdf.pageCount);
        setLoaded((count) => count + 1);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setFailure({ bytes, message: pdfErrorMessage(cause) });
      });
    return () => {
      cancelled = true;
      handle.current?.destroy();
      handle.current = null;
    };
  }, [bytes, id]);

  useEffect(() => {
    const element = pane.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const pdf = handle.current;
    const target = canvas.current;
    if (!pdf || !target || loaded === 0) return;
    const run = { cancelled: false };
    void (async () => {
      try {
        let scale = zoom;
        if (zoomMode === "actual") scale = 1;
        if (zoomMode === "fit") {
          const size = await pdf.pageSize(page);
          scale = Math.max(0.1, (Math.max(width, 200) - 32) / size.width);
        }
        if (!run.cancelled) await pdf.render(page, target, scale);
      } catch (cause: unknown) {
        const name =
          typeof cause === "object" && cause !== null && "name" in cause ? String(cause.name) : "";
        if (!run.cancelled && name !== "RenderingCancelledException")
          setFailure({ bytes, message: pdfErrorMessage(cause) });
      }
    })();
    return () => {
      run.cancelled = true;
    };
  }, [bytes, loaded, page, zoom, zoomMode, width]);

  if (error !== null) {
    return (
      <p className="file-preview__error" role="alert">
        {error}
      </p>
    );
  }
  return (
    <div className="file-preview__pdf" ref={pane}>
      <canvas ref={canvas} aria-label={`Page ${String(page)} of ${doc.name}`} />
    </div>
  );
}
