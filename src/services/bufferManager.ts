import * as monaco from "monaco-editor";

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

  getValue(id: string): string {
    return this.requireModel(id).getValue();
  }

  setValue(id: string, content: string): void {
    this.requireModel(id).setValue(content);
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
