import type { IpcClient } from "./ipc";
import type { DocxModel, PreviewInspection, PreviewKind, XlsxModel } from "./previewIpc";
import { parseCsv, type CsvTable } from "./preview/csv";
import { outlineLatex, type LatexOutline } from "./preview/latexOutline";
import { describeSvg } from "./preview/svgCheck";

/** What a preview tab shows, ready for the view to draw (nothing here is HTML the app would inject). */
export type PreviewModel =
  | { type: "image"; dataUrl: string; mime: string; notice: string | null }
  | { type: "pdf"; bytes: Uint8Array }
  | { type: "docx"; docx: DocxModel }
  | { type: "xlsx"; xlsx: XlsxModel }
  | { type: "csv"; table: CsvTable; partialFile: boolean }
  | { type: "markdown"; text: string }
  | { type: "html"; text: string }
  | { type: "latex"; outline: LatexOutline }
  | { type: "message"; message: string }
  /** A document an extension's file system provider served (a custom scheme): shown read-only (Milestone 18). */
  | { type: "virtualText"; text: string; language: string; extension: string; readonly: boolean }
  /** A Jupyter notebook: the notebook editor loads and edits it (`NotebookService`), Milestone 19. */
  | { type: "notebook" };

/** Whether a file is a Jupyter notebook (opened in the notebook editor, never run on open). */
export function isNotebookPath(path: string): boolean {
  return /\.ipynb$/i.test(path);
}

export type PreviewStatus = "loading" | "ready" | "error";
export type ZoomMode = "fit" | "actual" | "zoom";

export interface FilePreviewDoc {
  /** `pv:<n>`: never a text document's id. */
  id: string;
  path: string;
  name: string;
  info: PreviewInspection | null;
  status: PreviewStatus;
  error: string | null;
  model: PreviewModel | null;
  zoomMode: ZoomMode;
  zoom: number;
  page: number;
  pageCount: number;
  sheet: number;
  /// The image's own size, once the browser has decoded it.
  dimensions: { width: number; height: number } | null;
  /** Bumped by every (re)load so a view can tell a fresh model from the old one. */
  loadSeq: number;
}

export interface FilePreviewState {
  docs: Record<string, FilePreviewDoc>;
}

/** Kinds that are shown as a preview tab straight away (they aren't text). */
const DIRECT_KINDS: ReadonlySet<PreviewKind> = new Set(["image", "pdf", "docx", "xlsx"]);
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8];

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The kind by extension alone (what the backend also decides); no file access. */
export function kindOfPath(path: string): PreviewKind {
  const ext = extensionOf(path);
  if (ext in MIME) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx") return "xlsx";
  if (ext === "csv") return "csv";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "tex") return "latex";
  return "unsupported";
}

/** Text formats that also open in the text editor (and can be previewed from there). */
export function isPreviewableText(path: string): boolean {
  return ["csv", "markdown", "html", "latex"].includes(kindOfPath(path));
}

export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * The read-only previews open in tabs: one document per file path, loaded through the backend (validated,
 * size-limited, no program run, no network). Nothing here can be edited or saved; views read this state and ask
 * for zoom, page, sheet and reload changes through it.
 */
export class FilePreviewService {
  private readonly releaseListeners = new Set<(doc: FilePreviewDoc) => void>();
  private state: FilePreviewState = { docs: {} };
  private readonly listeners = new Set<() => void>();
  private readonly byPath = new Map<string, string>();
  private next = 1;

  constructor(private readonly ipc: IpcClient) {}

  getState(): FilePreviewState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  has(id: string): boolean {
    return id in this.state.docs;
  }

  get(id: string): FilePreviewDoc | undefined {
    return this.state.docs[id];
  }

  path(id: string): string | null {
    return this.state.docs[id]?.path ?? null;
  }

  /**
   * Whether opening `path` should give a preview tab instead of the text editor: images, PDF, DOCX and XLSX always
   * (they aren't text); any other file when it turns out to be binary or too large to load into the editor without
   * freezing it (the backend's limits: 10 MB for other files, 5 MB for Markdown/HTML/LaTeX, and a CSV over 8 MB is
   * previewed in part). Ordinary text and code open as text.
   */
  async shouldPreview(path: string): Promise<boolean> {
    if (isNotebookPath(path) || DIRECT_KINDS.has(kindOfPath(path))) return true;
    try {
      const info = await this.ipc.previewInspect(path);
      return info.binary || info.tooLarge;
    } catch {
      return false;
    }
  }

  /** Opens (or finds) the preview document of a file and starts loading it. */
  open(path: string): string {
    const key = normalizeKey(path);
    const existing = this.byPath.get(key);
    if (existing !== undefined && this.has(existing)) return existing;
    const id = `pv:${String(this.next)}`;
    this.next += 1;
    this.byPath.set(key, id);
    const name = path.split(/[\\/]/).pop() ?? path;
    this.set({
      ...this.state.docs,
      [id]: {
        id,
        path,
        name,
        info: null,
        status: "loading",
        error: null,
        model: null,
        zoomMode: "fit",
        zoom: 1,
        page: 1,
        pageCount: 0,
        sheet: 0,
        dimensions: null,
        loadSeq: 0,
      },
    });
    void this.load(id);
    return id;
  }

  /**
   * Opens (or refreshes) a read-only tab for a custom-scheme document an extension served (`memfs:/a.txt`). The text
   * comes from the extension; nothing is read from disk, and the tab can't be edited or saved.
   */
  openVirtual(request: {
    uri: string;
    text: string;
    language: string;
    extension: string;
    readonly: boolean;
  }): string {
    const key = `virtual:${request.uri}`;
    const model: PreviewModel = {
      type: "virtualText",
      text: request.text,
      language: request.language,
      extension: request.extension,
      readonly: request.readonly,
    };
    const existing = this.byPath.get(key);
    if (existing !== undefined && this.has(existing)) {
      this.patch(existing, {
        model,
        status: "ready",
        error: null,
        loadSeq: (this.get(existing)?.loadSeq ?? 0) + 1,
      });
      return existing;
    }
    const id = `pv:${String(this.next)}`;
    this.next += 1;
    this.byPath.set(key, id);
    const name = request.uri.split("/").pop() || request.uri;
    this.set({
      ...this.state.docs,
      [id]: {
        id,
        path: request.uri,
        name,
        info: null,
        status: "ready",
        error: null,
        model,
        zoomMode: "fit",
        zoom: 1,
        page: 1,
        pageCount: 0,
        sheet: 0,
        dimensions: null,
        loadSeq: 1,
      },
    });
    return id;
  }

  /** Whether this preview shows an extension's custom-scheme document (it has no file to reload). */
  isVirtual(id: string): boolean {
    return this.state.docs[id]?.model?.type === "virtualText";
  }

  /** Whether the file can be inspected at all (used before restoring a saved tab). */
  async exists(path: string): Promise<boolean> {
    try {
      await this.ipc.previewInspect(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Called with the path of a preview whose last tab closed (a notebook stops its kernel). */
  onRelease(listener: (doc: FilePreviewDoc) => void): () => void {
    this.releaseListeners.add(listener);
    return () => {
      this.releaseListeners.delete(listener);
    };
  }

  release(id: string): void {
    const doc = this.state.docs[id];
    if (!doc) return;
    for (const listener of this.releaseListeners) listener(doc);
    this.byPath.delete(
      doc.model?.type === "virtualText" ? `virtual:${doc.path}` : normalizeKey(doc.path),
    );
    this.set(Object.fromEntries(Object.entries(this.state.docs).filter(([key]) => key !== id)));
  }

  /** Loads the file again from disk (Reload Preview), keeping zoom, page and sheet. */
  async reload(id: string): Promise<void> {
    if (this.isVirtual(id)) return; // its text comes from the extension, not from a file
    await this.load(id);
  }

  private patch(id: string, change: Partial<FilePreviewDoc>): void {
    const doc = this.state.docs[id];
    if (!doc) return;
    this.set({ ...this.state.docs, [id]: { ...doc, ...change } });
  }

  private set(docs: Record<string, FilePreviewDoc>): void {
    this.state = { docs };
    for (const listener of this.listeners) listener();
  }

  private async load(id: string): Promise<void> {
    const doc = this.state.docs[id];
    if (!doc) return;
    const seq = doc.loadSeq + 1;
    if (isNotebookPath(doc.path)) {
      // The notebook editor reads the file itself (nothing runs on open).
      this.patch(id, { status: "ready", error: null, model: { type: "notebook" }, loadSeq: seq });
      return;
    }
    this.patch(id, { status: "loading", error: null, loadSeq: seq });
    try {
      const info = await this.ipc.previewInspect(doc.path);
      const model = await this.build(info, doc.sheet);
      const current = this.state.docs[id];
      if (current?.loadSeq !== seq) return; // a newer load (or a release) took over
      this.patch(id, { info, model, status: "ready", error: null });
    } catch (error) {
      if (this.state.docs[id]?.loadSeq !== seq) return;
      this.patch(id, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        model: null,
      });
    }
  }

  private async build(info: PreviewInspection, sheet: number): Promise<PreviewModel> {
    if (info.kind === "unsupported" && !info.tooLarge) {
      return {
        type: "message",
        message: info.binary
          ? "This file appears to be binary and cannot be previewed safely."
          : "Preview not available for this file type.",
      };
    }
    if (
      info.binary &&
      info.kind !== "image" &&
      info.kind !== "pdf" &&
      info.kind !== "docx" &&
      info.kind !== "xlsx"
    ) {
      return {
        type: "message",
        message: "This file appears to be binary and cannot be previewed safely.",
      };
    }
    if (info.tooLarge && info.kind !== "csv") {
      return {
        type: "message",
        message: `This file is ${formatBytes(info.size)}, more than the ${formatBytes(info.limit)} preview limit for this type.`,
      };
    }
    switch (info.kind) {
      case "image": {
        const base64 = await this.ipc.previewReadBytes(info.path);
        const ext = extensionOf(info.path);
        const mime = MIME[ext] ?? "application/octet-stream";
        const notice =
          ext === "svg" ? describeSvg(new TextDecoder().decode(decodeBase64(base64))) : null;
        return { type: "image", dataUrl: `data:${mime};base64,${base64}`, mime, notice };
      }
      case "pdf":
        return { type: "pdf", bytes: decodeBase64(await this.ipc.previewReadBytes(info.path)) };
      case "docx":
        return { type: "docx", docx: await this.ipc.previewDocx(info.path) };
      case "xlsx":
        return { type: "xlsx", xlsx: await this.ipc.previewXlsx(info.path, sheet) };
      case "csv": {
        const read = await this.ipc.previewReadText(info.path);
        return { type: "csv", table: parseCsv(read.text), partialFile: read.truncated };
      }
      case "markdown":
        return { type: "markdown", text: (await this.ipc.previewReadText(info.path)).text };
      case "html":
        return { type: "html", text: (await this.ipc.previewReadText(info.path)).text };
      case "latex":
        return {
          type: "latex",
          outline: outlineLatex((await this.ipc.previewReadText(info.path)).text),
        };
      default:
        return { type: "message", message: "Preview not available for this file type." };
    }
  }

  // --- View state: zoom, page, sheet ---

  zoomable(id: string): boolean {
    const model = this.state.docs[id]?.model;
    return model?.type === "image" || model?.type === "pdf";
  }

  private stepZoom(id: string, direction: 1 | -1): void {
    const doc = this.state.docs[id];
    if (!doc || !this.zoomable(id)) return;
    const base = doc.zoomMode === "zoom" ? doc.zoom : 1;
    const target =
      direction > 0
        ? ZOOM_STEPS.find((step) => step > base + 1e-9)
        : [...ZOOM_STEPS].reverse().find((step) => step < base - 1e-9);
    const next = target ?? base;
    this.patch(id, { zoomMode: "zoom", zoom: next });
  }

  zoomIn(id: string): void {
    this.stepZoom(id, 1);
  }

  zoomOut(id: string): void {
    this.stepZoom(id, -1);
  }

  fit(id: string): void {
    if (this.zoomable(id)) this.patch(id, { zoomMode: "fit", zoom: 1 });
  }

  actualSize(id: string): void {
    if (this.zoomable(id)) this.patch(id, { zoomMode: "actual", zoom: 1 });
  }

  setDimensions(id: string, width: number, height: number): void {
    this.patch(id, { dimensions: { width, height } });
  }

  setPageCount(id: string, count: number): void {
    const doc = this.state.docs[id];
    if (doc)
      this.patch(id, {
        pageCount: count,
        page: Math.min(Math.max(1, doc.page), Math.max(1, count)),
      });
  }

  setPage(id: string, page: number): void {
    const doc = this.state.docs[id];
    if (!doc || doc.pageCount === 0) return;
    this.patch(id, { page: Math.min(Math.max(1, Math.round(page)), doc.pageCount) });
  }

  /** Shows another sheet of a workbook (loaded from the file, one sheet at a time). */
  async setSheet(id: string, sheet: number): Promise<void> {
    const doc = this.state.docs[id];
    if (!doc || doc.model?.type !== "xlsx") return;
    this.patch(id, { sheet });
    await this.load(id);
  }
}
