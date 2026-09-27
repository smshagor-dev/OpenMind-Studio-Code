import type { FilePreviewDoc } from "../filePreviewService";

/** The AI actions that start from something the user selected or is looking at. */
export type AiActionKind = "explain" | "fix" | "docs" | "terminal" | "preview";

/** A hard limit for what one action attaches; larger content is refused, not silently cut. */
export const MAX_ACTION_CHARS = 100_000;

export interface AiSelection {
  text: string;
  languageId: string;
  fileName: string | null;
  startLine: number;
  endLine: number;
}

/** What kind of tab is in front: only a text tab has an `activeTextEditor`. */
export type ActiveKind = "text" | "preview" | "none";

export interface PreviewText {
  text: string | null;
  /** Why there is no text to summarize. */
  reason: string | null;
}

/** The selected text as a fenced block, tagged with its language. */
export function fenced(text: string, language: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function where(selection: AiSelection): string {
  const file = selection.fileName === null ? "" : ` from ${selection.fileName}`;
  const lines =
    selection.startLine === selection.endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}-${selection.endLine}`;
  return `${file} (${lines})`;
}

export function explainPrompt(selection: AiSelection): string {
  return `Explain what this ${selection.languageId} code${where(selection)} does, clearly and briefly.\n\n${fenced(selection.text, selection.languageId)}`;
}

export function fixPrompt(selection: AiSelection): string {
  return (
    `Find any bugs or problems in this ${selection.languageId} code${where(selection)} and suggest a fix. ` +
    `Explain the problem in a sentence or two, then show the corrected code.\n\n${fenced(selection.text, selection.languageId)}`
  );
}

export function docsPrompt(selection: AiSelection): string {
  return (
    `Write a documentation comment (docstring or doc comment, in the idiomatic style for ${selection.languageId}) ` +
    `for this code${where(selection)}. Reply with only the comment in a code block.\n\n${fenced(selection.text, selection.languageId)}`
  );
}

export function terminalPrompt(output: string): string {
  return `Explain this terminal output or error and suggest how to fix it.\n\n${fenced(output, "text")}`;
}

export function previewPrompt(name: string, kind: string, text: string): string {
  return `Summarize this ${kind} document "${name}" in a few bullet points.\n\n${fenced(text, "text")}`;
}

const NO_TEXT = "Images and PDFs have no text to summarize here (they are never sent).";

/**
 * The text of a preview that can be summarized, or the reason it can't. Only text the preview already holds is
 * used (Markdown, HTML source, CSV rows, DOCX paragraphs, LaTeX source structure); nothing is read again, no
 * OCR, and an image, PDF or spreadsheet is never sent.
 */
export function previewText(doc: FilePreviewDoc): PreviewText {
  if (doc.status !== "ready" || doc.model === null) {
    return { text: null, reason: "The preview is not loaded yet." };
  }
  const model = doc.model;
  switch (model.type) {
    case "markdown":
    case "html":
      return { text: model.text, reason: null };
    case "csv":
      return { text: model.table.rows.map((row) => row.join(", ")).join("\n"), reason: null };
    case "docx": {
      const lines = model.docx.blocks.map((block) =>
        block.type === "paragraph"
          ? block.text
          : block.rows.map((row) => row.join(" | ")).join("\n"),
      );
      return { text: lines.join("\n"), reason: null };
    }
    case "latex": {
      const lines = model.outline.blocks.map((block) => block.text);
      return { text: lines.join("\n"), reason: null };
    }
    case "image":
    case "pdf":
      return { text: null, reason: NO_TEXT };
    case "xlsx":
      return { text: null, reason: "Spreadsheet previews are not summarized." };
    case "message":
      return { text: null, reason: "This preview has no text to summarize." };
    case "virtualText":
      return { text: model.text, reason: null };
  }
}
