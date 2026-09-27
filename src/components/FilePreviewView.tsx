import { useRef, useSyncExternalStore, type ReactNode } from "react";

import { container } from "../services/container";
import {
  formatBytes,
  type FilePreviewDoc,
  type PreviewModel,
} from "../services/filePreviewService";
import { safeHref } from "../services/markdown";
import type { PreviewKind } from "../services/previewIpc";
import "../styles/filePreview.css";
import { DocxPreview } from "./filePreview/DocxPreview";
import { HtmlPreview } from "./filePreview/HtmlPreview";
import { ImagePreview } from "./filePreview/ImagePreview";
import { LatexPreview } from "./filePreview/LatexPreview";
import { PdfPreview } from "./filePreview/PdfPreview";
import { SheetPreview } from "./filePreview/SheetPreview";
import { VirtualTextPreview } from "./filePreview/VirtualTextPreview";
import { MarkdownText } from "./MarkdownPreview";

const KIND_LABEL: Record<PreviewKind, string> = {
  image: "Image",
  pdf: "PDF",
  docx: "Word document",
  xlsx: "Excel workbook",
  csv: "CSV",
  markdown: "Markdown",
  html: "HTML",
  latex: "LaTeX source",
  unsupported: "File",
};

function zoomLabel(doc: FilePreviewDoc): string {
  if (doc.zoomMode === "fit") return "Fit";
  return `${String(Math.round((doc.zoomMode === "actual" ? 1 : doc.zoom) * 100))}%`;
}

function ToolButton({
  label,
  onClick,
  disabled,
  reason,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  reason?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="file-preview__button"
      aria-label={label}
      title={disabled === true && reason ? `${label} — ${reason}` : label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PageControls({ doc }: { doc: FilePreviewDoc }) {
  const { filePreviews } = container;
  return (
    <div className="file-preview__group" role="group" aria-label="Pages">
      <ToolButton
        label="Previous Page"
        disabled={doc.page <= 1}
        reason="This is the first page."
        onClick={() => {
          filePreviews.setPage(doc.id, doc.page - 1);
        }}
      >
        ‹
      </ToolButton>
      <span className="file-preview__page">
        <input
          type="number"
          aria-label="Page number"
          min={1}
          max={Math.max(1, doc.pageCount)}
          value={doc.page}
          onChange={(event) => {
            filePreviews.setPage(doc.id, Number(event.target.value));
          }}
        />
        <span>/ {doc.pageCount === 0 ? "…" : doc.pageCount}</span>
      </span>
      <ToolButton
        label="Next Page"
        disabled={doc.pageCount === 0 || doc.page >= doc.pageCount}
        reason="This is the last page."
        onClick={() => {
          filePreviews.setPage(doc.id, doc.page + 1);
        }}
      >
        ›
      </ToolButton>
    </div>
  );
}

function ZoomControls({ doc }: { doc: FilePreviewDoc }) {
  const { filePreviews } = container;
  return (
    <div className="file-preview__group" role="group" aria-label="Zoom">
      <ToolButton
        label="Zoom Out"
        onClick={() => {
          filePreviews.zoomOut(doc.id);
        }}
      >
        −
      </ToolButton>
      <span className="file-preview__zoom" aria-live="polite">
        {zoomLabel(doc)}
      </span>
      <ToolButton
        label="Zoom In"
        onClick={() => {
          filePreviews.zoomIn(doc.id);
        }}
      >
        +
      </ToolButton>
      <ToolButton
        label="Fit to Screen"
        onClick={() => {
          filePreviews.fit(doc.id);
        }}
      >
        Fit
      </ToolButton>
      <ToolButton
        label="Actual Size"
        onClick={() => {
          filePreviews.actualSize(doc.id);
        }}
      >
        1:1
      </ToolButton>
    </div>
  );
}

function Toolbar({ doc }: { doc: FilePreviewDoc }) {
  const { filePreviews, workspace } = container;
  const { info, model } = doc;
  const textSafe = info?.textSafe === true;
  const meta = [
    info ? KIND_LABEL[info.kind] : null,
    info ? formatBytes(info.size) : null,
    doc.dimensions ? `${String(doc.dimensions.width)} × ${String(doc.dimensions.height)} px` : null,
  ].filter((part): part is string => part !== null);
  return (
    <div className="file-preview__toolbar" role="toolbar" aria-label="Preview">
      <span className="file-preview__name" title={doc.path}>
        {doc.name}
      </span>
      <span className="file-preview__meta">
        {model?.type === "virtualText" ? `Served by ${model.extension} · read-only` : meta.join(" · ")}
      </span>
      <span className="file-preview__badge" title="Previews never change the file.">
        Read-only preview
      </span>
      <span className="file-preview__spacer" />
      {model?.type === "pdf" ? <PageControls doc={doc} /> : null}
      {model?.type === "image" || model?.type === "pdf" ? <ZoomControls doc={doc} /> : null}
      <ToolButton
        label="Open as Text"
        disabled={!textSafe}
        reason={
          model?.type === "virtualText"
            ? "An extension's document can only be viewed here (it isn't a file on disk)."
            : info === null
              ? "The file is still loading."
              : "This file isn't text, or is too large to open as text."
        }
        onClick={() => {
          void workspace.openAsText(doc.id);
        }}
      >
        Open as Text
      </ToolButton>
      <ToolButton
        label="Reload Preview"
        disabled={model?.type === "virtualText"}
        reason="Ask the extension to open the document again to refresh it."
        onClick={() => {
          void filePreviews.reload(doc.id);
        }}
      >
        Reload
      </ToolButton>
    </div>
  );
}

function MarkdownFilePreview({ doc, text }: { doc: FilePreviewDoc; text: string }) {
  const root = useRef<HTMLDivElement | null>(null);
  return (
    <div className="file-preview__markdown" ref={root}>
      <MarkdownText
        text={text}
        onLink={(href) => {
          const target = safeHref(href);
          if (target?.kind === "anchor") {
            root.current
              ?.querySelector(`[data-anchor="${CSS.escape(target.id.toLowerCase())}"]`)
              ?.scrollIntoView();
            return;
          }
          void container.markdown.followLink(doc.id, href);
        }}
      />
    </div>
  );
}

function Body({ doc, model }: { doc: FilePreviewDoc; model: PreviewModel }) {
  switch (model.type) {
    case "image":
      return <ImagePreview doc={doc} dataUrl={model.dataUrl} notice={model.notice} />;
    case "pdf":
      return <PdfPreview doc={doc} bytes={model.bytes} />;
    case "docx":
      return <DocxPreview docx={model.docx} />;
    case "xlsx":
    case "csv":
      return <SheetPreview doc={doc} model={model} />;
    case "markdown":
      return <MarkdownFilePreview doc={doc} text={model.text} />;
    case "html":
      return <HtmlPreview text={model.text} />;
    case "latex":
      return <LatexPreview outline={model.outline} />;
    case "virtualText":
      return <VirtualTextPreview text={model.text} language={model.language} />;
    case "message":
      return (
        <div className="file-preview__message" role="status">
          <p>{model.message}</p>
          {doc.info ? (
            <p className="file-preview__meta">
              {doc.name} · {formatBytes(doc.info.size)}
            </p>
          ) : null}
        </div>
      );
  }
}

/**
 * A read-only file preview in an editor tab: a toolbar (name, type, size, zoom, pages, Open as Text, Reload) over the
 * kind's view. It has no dirty state and no Save, and the file is never modified.
 */
export function FilePreviewView({ docId }: { docId: string }) {
  const { filePreviews } = container;
  const state = useSyncExternalStore(
    (listener) => filePreviews.subscribe(listener),
    () => filePreviews.getState(),
  );
  const doc = state.docs[docId];
  if (!doc) {
    return <div className="file-preview file-preview__empty">This preview is no longer open.</div>;
  }
  return (
    <section className="file-preview" aria-label={`Preview of ${doc.name}`}>
      <Toolbar doc={doc} />
      <div className="file-preview__body">
        {doc.status === "error" ? (
          <p className="file-preview__error" role="alert">
            {doc.error ?? "The preview couldn't be shown."}
          </p>
        ) : doc.model === null ? (
          <p className="file-preview__empty">Loading preview…</p>
        ) : (
          <Body doc={doc} model={doc.model} />
        )}
      </div>
    </section>
  );
}
