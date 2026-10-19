import * as monaco from "monaco-editor";

import type { DocumentService } from "../documentService";
import type { Bookmark, BookmarkService } from "./bookmarkService";

/** The marks of a file's bookmarks: beside the line numbers and in the scroll bar (pure, so testable). */
export function bookmarkDecorations(
  bookmarks: readonly Bookmark[],
  tooltip: (bookmark: Bookmark) => string,
): monaco.editor.IModelDeltaDecoration[] {
  return bookmarks.map((bm) => ({
    range: new monaco.Range(bm.line, 1, bm.line, 1),
    options: {
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      linesDecorationsClassName: "bookmark-mark",
      linesDecorationsTooltip: tooltip(bm),
      overviewRuler: {
        color: { id: "editorInfo.foreground" },
        position: monaco.editor.OverviewRulerLane.Left,
      },
    },
  }));
}

interface Deps {
  documents: DocumentService;
  bookmarks: BookmarkService;
  tooltip: (bookmark: Bookmark) => string;
}

/**
 * Draws each editor's bookmarks and moves a bookmark with its line when the text above it is edited (the same
 * tracked-decoration approach as breakpoints). Every editor Monaco creates is covered.
 */
export function registerBookmarkEditorBinding(deps: Deps): monaco.IDisposable {
  const attached = new Map<monaco.editor.ICodeEditor, () => void>();
  const refreshers = new Set<() => void>();

  const pathOf = (model: monaco.editor.ITextModel | null): string | null => {
    if (!model) return null;
    const id = deps.documents.idForModelUri(model.uri.toString());
    return id === undefined ? null : deps.documents.snapshot(id).path;
  };

  const attach = (editor: monaco.editor.ICodeEditor) => {
    if (attached.has(editor)) return;
    const marks = editor.createDecorationsCollection();
    let ids: string[] = [];
    let contentSub: monaco.IDisposable | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      const path = pathOf(editor.getModel());
      const list = path === null ? [] : deps.bookmarks.forFile(path);
      ids = list.map((bm) => bm.id);
      marks.set(bookmarkDecorations(list, deps.tooltip));
    };
    const follow = () => {
      const moves = ids.flatMap((id, index) => {
        const range = marks.getRange(index);
        return range ? [{ id, line: range.startLineNumber }] : [];
      });
      deps.bookmarks.moveLines(moves);
    };
    const bindModel = () => {
      contentSub?.dispose();
      contentSub =
        editor.getModel()?.onDidChangeContent(() => {
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(follow, 200);
        }) ?? null;
      refresh();
    };

    const subscriptions = [
      editor.onDidChangeModel(bindModel),
      editor.onDidDispose(() => {
        attached.get(editor)?.();
        attached.delete(editor);
      }),
    ];
    refreshers.add(refresh);
    bindModel();
    attached.set(editor, () => {
      for (const subscription of subscriptions) subscription.dispose();
      contentSub?.dispose();
      if (timer !== null) clearTimeout(timer);
      refreshers.delete(refresh);
      marks.clear();
    });
  };

  const created = monaco.editor.onDidCreateEditor(attach);
  for (const editor of monaco.editor.getEditors()) attach(editor);
  const off = deps.bookmarks.subscribe(() => {
    for (const refresh of refreshers) refresh();
  });

  return {
    dispose: () => {
      created.dispose();
      off();
      for (const detach of attached.values()) detach();
      attached.clear();
    },
  };
}
