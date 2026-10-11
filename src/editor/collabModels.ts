import * as monaco from "monaco-editor";

let counter = 0;

/** Models shown under a fixed identity (`omcollab://<room>/<file id>`), with how many holders use each. */
const shared = new Map<string, number>();

/**
 * Models that have followed a live collaborative document. From then on their text belongs to the CRDT: a snapshot
 * must never be written into them again — even while the room is unreachable, since the binding would turn that
 * write into deletions of everyone's edits the moment the room is back.
 */
const followedCrdt = new WeakSet<monaco.editor.ITextModel>();

export function markLive(model: monaco.editor.ITextModel): void {
  followedCrdt.add(model);
}

export function wasLive(model: monaco.editor.ITextModel): boolean {
  return followedCrdt.has(model);
}

function languageId(language: string): string {
  return monaco.languages.getLanguages().some((l) => l.id === language) ? language : "plaintext";
}

/**
 * The model for a custom-scheme document. With a `uri` (a remote collaboration document) there is one model per
 * identity, shared by every view and by the collaborative-editing binding, disposed when its last holder lets go;
 * without one, a private model.
 */
export function acquireModel(
  uri: string | null,
  text: string,
  language: string,
): monaco.editor.ITextModel {
  if (uri === null) {
    counter += 1;
    return monaco.editor.createModel(
      text,
      languageId(language),
      monaco.Uri.parse(`openmind-virtual:/doc-${String(counter)}`),
    );
  }
  const parsed = monaco.Uri.parse(uri);
  shared.set(uri, (shared.get(uri) ?? 0) + 1);
  return (
    monaco.editor.getModel(parsed) ?? monaco.editor.createModel(text, languageId(language), parsed)
  );
}

export function releaseModel(uri: string | null, model: monaco.editor.ITextModel): void {
  if (uri !== null) {
    const left = (shared.get(uri) ?? 1) - 1;
    if (left > 0) {
      shared.set(uri, left);
      return;
    }
    shared.delete(uri);
  }
  model.dispose();
}
