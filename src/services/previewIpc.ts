import { invoke } from "@tauri-apps/api/core";

// Mirrors openmind_preview (serde camelCase).
export type PreviewKind =
  "image" | "pdf" | "docx" | "xlsx" | "csv" | "markdown" | "html" | "latex" | "unsupported";

export interface PreviewInspection {
  path: string;
  name: string;
  size: number;
  kind: PreviewKind;
  /** Not text (NUL bytes, or an image/PDF/Office file). */
  binary: boolean;
  tooLarge: boolean;
  limit: number;
  /** "Open as Text" is safe for this file. */
  textSafe: boolean;
}

export interface TextRead {
  text: string;
  truncated: boolean;
}

export type DocxBlock =
  | { type: "paragraph"; text: string; heading: number | null; list: boolean }
  | { type: "table"; rows: string[][] };

export interface DocxModel {
  blocks: DocxBlock[];
  metadata: {
    title: string | null;
    author: string | null;
    created: string | null;
    modified: string | null;
  };
  imageCount: number;
  hasMacros: boolean;
  truncated: boolean;
}

export interface SheetModel {
  name: string;
  rows: string[][];
  totalRows: number;
  totalCols: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
}

export interface XlsxModel {
  sheets: string[];
  selected: number;
  sheet: SheetModel;
  hasMacros: boolean;
}

/** The read-only preview commands (all validated and size-limited in Rust; nothing is ever run or uploaded). */
export interface PreviewIpc {
  previewInspect: (path: string) => Promise<PreviewInspection>;
  /** An image or PDF as base64. */
  previewReadBytes: (path: string) => Promise<string>;
  previewReadText: (path: string) => Promise<TextRead>;
  previewDocx: (path: string) => Promise<DocxModel>;
  previewXlsx: (path: string, sheet: number) => Promise<XlsxModel>;
}

export const tauriPreviewIpc: PreviewIpc = {
  previewInspect: (path) => invoke<PreviewInspection>("preview_inspect", { path }),
  previewReadBytes: (path) => invoke<string>("preview_read_bytes", { path }),
  previewReadText: (path) => invoke<TextRead>("preview_read_text", { path }),
  previewDocx: (path) => invoke<DocxModel>("preview_docx", { path }),
  previewXlsx: (path, sheet) => invoke<XlsxModel>("preview_xlsx", { path, sheet }),
};
