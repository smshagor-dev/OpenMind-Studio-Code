import * as monaco from "monaco-editor";

import type { HostTextEdit } from "./hostEdits";
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

  /**
   * Applies edits from an extension as ONE undoable step. Everything is checked first (every range inside
   * the text, no two ranges overlapping) so a bad batch changes nothing. Line/column are 0-based.
   */
  applyHostEdits(id: string, edits: HostTextEdit[]): void {
    const model = this.requireModel(id);
    const operations = edits.map((edit) => {
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
    const sorted = [...operations].sort((a, b) => (a.offsets[0] ?? 0) - (b.offsets[0] ?? 0));
    for (let i = 1; i < sorted.length; i += 1) {
      if ((sorted[i]?.offsets[0] ?? 0) < (sorted[i - 1]?.offsets[1] ?? 0)) {
        throw new Error("Overlapping ranges are not allowed!");
      }
    }
    model.pushStackElement();
    model.pushEditOperations(
      [],
      operations.map(({ range, text }) => ({ range, text })),
      () => null,
    );
    model.pushStackElement();
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
