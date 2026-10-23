import * as monaco from "monaco-editor";

import type { HostEditOptions, HostTextEdit } from "./hostEdits";
import { minimalEdit } from "./textSync";

/**
 * Owns the lifecycle of in-memory text buffers (Monaco text models). Knows
 * nothing about files, paths, or persistence — that's DocumentService's
 * job. Monaco models exist independently of any editor instance showing
 * them, so content-change listeners registered here fire whether or not a
 * `MonacoHost` is currently mounted for this buffer.
 */
export class BufferManager {
  private readonly models = new Map<string, monaco.editor.ITextModel>();

  create(id: string, content: string, languageId = "plaintext"): monaco.editor.ITextModel {
    if (this.models.has(id)) {
      throw new Error(`buffer "${id}" already exists`);
    }
    const model = monaco.editor.createModel(content, languageId);
    this.models.set(id, model);
    return model;
  }

  get(id: string): monaco.editor.ITextModel | undefined {
    return this.models.get(id);
  }

  /** The buffer whose Monaco model has this URI (how markers and editors refer to a document). */
  idForUri(uri: string): string | undefined {
    for (const [id, model] of this.models) {
      if (model.uri.toString() === uri) return id;
    }
    return undefined;
  }

  setLanguage(id: string, languageId: string): void {
    monaco.editor.setModelLanguage(this.requireModel(id), languageId);
  }

  getLanguage(id: string): string {
    return this.requireModel(id).getLanguageId();
  }

  getValue(id: string): string {
    return this.requireModel(id).getValue();
  }

  setValue(id: string, content: string): void {
    this.requireModel(id).setValue(content);
  }

  /**
   * Replaces the text with `content` by editing only what differs, so the
   * cursor, selections and scroll position outside the changed part stay put
   * (unlike `setValue`, which resets them). Goes on the undo stack, so the
   * user can undo a reload.
   */
  replaceContent(id: string, content: string): void {
    const model = this.requireModel(id);
    const edit = minimalEdit(model.getValue(), content);
    if (edit === null) return;
    const range = monaco.Range.fromPositions(
      model.getPositionAt(edit.start),
      model.getPositionAt(edit.end),
    );
    model.pushEditOperations([], [{ range, text: edit.text }], () => null);
  }

  /** The line ending of the text as the model holds it (a model has one). */
  eolOf(id: string): "\n" | "\r\n" {
    return this.requireModel(id).getEOL() === "\r\n" ? "\r\n" : "\n";
  }

  /** One indentation level as the model uses it (its tab size / insert-spaces, which follow the detected indentation). */
  indentUnitOf(id: string): string {
    const { insertSpaces, tabSize } = this.requireModel(id).getOptions();
    return insertSpaces ? " ".repeat(tabSize) : "\t";
  }

  /** The text that results from applying language-server style edits to the model's text; the model is not changed. */
  textWithEdits(id: string, edits: { range: monaco.IRange; text: string }[]): string {
    const model = this.requireModel(id);
    const text = model.getValue();
    const spans = edits
      .map((edit) => ({
        start: model.getOffsetAt({
          lineNumber: edit.range.startLineNumber,
          column: edit.range.startColumn,
        }),
        end: model.getOffsetAt({
          lineNumber: edit.range.endLineNumber,
          column: edit.range.endColumn,
        }),
        text: edit.text,
      }))
      .sort((a, b) => b.start - a.start);
    let out = text;
    for (const span of spans) out = out.slice(0, span.start) + span.text + out.slice(span.end);
    return out;
  }

  /**
   * Applies edits from an extension as ONE undoable step. Everything is checked first (every range inside
   * the text, no two ranges overlapping) so a bad batch changes nothing. Line/column are 0-based.
   */
  private hostOperations(id: string, edits: HostTextEdit[]) {
    const model = this.requireModel(id);
    const operations = edits.map((edit) => {
      if (edit.startLine > edit.endLine || (edit.startLine === edit.endLine && edit.startColumn > edit.endColumn)) {
        throw new Error("An edit range is reversed.");
      }
      const range = new monaco.Range(
        edit.startLine + 1,
        edit.startColumn + 1,
        edit.endLine + 1,
        edit.endColumn + 1,
      );
      if (!model.validateRange(range).equalsRange(range)) {
        throw new Error("An edit is outside the document.");
      }
      return {
        range,
        text: edit.text,
        offsets: [
          model.getOffsetAt(range.getStartPosition()),
          model.getOffsetAt(range.getEndPosition()),
        ],
      };
    });
    const sorted = [...operations].sort((a, b) => (a.offsets[0] ?? 0) - (b.offsets[0] ?? 0) || (a.offsets[1] ?? 0) - (b.offsets[1] ?? 0));
    for (let i = 1; i < sorted.length; i += 1) {
      if ((sorted[i]?.offsets[0] ?? 0) < (sorted[i - 1]?.offsets[1] ?? 0)) {
        throw new Error("Overlapping ranges are not allowed!");
      }
    }
    return { model, operations };
  }

  /** Validate a complete batch before any of its models are changed. */
  validateHostEdits(id: string, edits: HostTextEdit[]): void {
    this.hostOperations(id, edits);
  }

  applyHostEdits(id: string, edits: HostTextEdit[], options: HostEditOptions = {}): void {
    const { model, operations } = this.hostOperations(id, edits);
    if (!operations.length && options.eol === undefined) return;
    if (options.undoStopBefore !== false) model.pushStackElement();
    if (operations.length) {
      model.pushEditOperations(
        [],
        operations.map(({ range, text }) => ({ range, text })),
        () => null,
      );
    }
    if (options.eol !== undefined) {
      model.pushEOL(options.eol === 1 ? monaco.editor.EndOfLineSequence.LF : monaco.editor.EndOfLineSequence.CRLF);
    }
    if (options.undoStopAfter !== false) model.pushStackElement();
  }

  /** Replaces the markers `owner` set on the buffer (an empty list clears them). */
  setMarkers(id: string, owner: string, markers: monaco.editor.IMarkerData[]): void {
    monaco.editor.setModelMarkers(this.requireModel(id), owner, markers);
  }

  onDidChangeContent(id: string, listener: () => void): () => void {
    const disposable = this.requireModel(id).onDidChangeContent(() => {
      listener();
    });
    return () => {
      disposable.dispose();
    };
  }

  dispose(id: string): void {
    const model = this.models.get(id);
    if (!model) return;
    model.dispose();
    this.models.delete(id);
  }

  disposeAll(): void {
    for (const id of [...this.models.keys()]) {
      this.dispose(id);
    }
  }

  private requireModel(id: string): monaco.editor.ITextModel {
    const model = this.models.get(id);
    if (!model) {
      throw new Error(`buffer "${id}" does not exist`);
    }
    return model;
  }
}

