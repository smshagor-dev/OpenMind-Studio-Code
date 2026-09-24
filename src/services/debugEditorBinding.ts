import * as monaco from "monaco-editor";

import type { Breakpoint, BreakpointService } from "./breakpointService";
import type { CallStackService, DebugLocation } from "./callStackService";
import type { DocumentService } from "./documentService";
import { pathKey } from "./textSync";

/** The gutter marks of a file's breakpoints (pure, so the rules are testable without an editor). */
export function breakpointDecorations(
  breakpoints: readonly Breakpoint[],
): monaco.editor.IModelDeltaDecoration[] {
  return breakpoints.map((bp) => {
    const kind = bp.stale ? "stale" : bp.enabled ? "on" : "off";
    return {
      range: new monaco.Range(bp.line, 1, bp.line, 1),
      options: {
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        glyphMarginClassName: `debug-bp debug-bp--${kind}`,
        glyphMarginHoverMessage: {
          value:
            kind === "stale"
              ? "Breakpoint ignored: its file no longer exists."
              : kind === "off"
                ? "Disabled breakpoint"
                : "Breakpoint",
        },
      },
    };
  });
}

/** The marker of the line the paused program is on. */
export function currentLineDecoration(
  location: DebugLocation,
): monaco.editor.IModelDeltaDecoration {
  return {
    range: new monaco.Range(location.line, 1, location.line, 1),
    options: {
      isWholeLine: true,
      className: "debug-current-line",
      glyphMarginClassName: "debug-current-glyph",
    },
  };
}

interface Deps {
  documents: DocumentService;
  breakpoints: BreakpointService;
  callStack: CallStackService;
}

/**
 * Connects the editors to the debugger state: a click in the glyph margin toggles a breakpoint,
 * breakpoints and the paused line are drawn as decorations, and a breakpoint follows its line when
 * the text above it is edited. Every editor Monaco creates gets the margin.
 */
export function registerDebugEditorBinding(deps: Deps): monaco.IDisposable {
  const attached = new Map<monaco.editor.ICodeEditor, () => void>();
  const refreshers = new Set<() => void>();

  const pathOf = (model: monaco.editor.ITextModel | null): string | null => {
    if (!model) return null;
    const id = deps.documents.idForModelUri(model.uri.toString());
    return id === undefined ? null : deps.documents.snapshot(id).path;
  };

  const attach = (editor: monaco.editor.ICodeEditor) => {
    if (attached.has(editor)) return;
    editor.updateOptions({ glyphMargin: true });
    const marks = editor.createDecorationsCollection();
    const current = editor.createDecorationsCollection();
    let ids: string[] = [];
    let contentSub: monaco.IDisposable | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      const path = pathOf(editor.getModel());
      const list = path === null ? [] : deps.breakpoints.forFile(path);
      ids = list.map((bp) => bp.id);
      marks.set(breakpointDecorations(list));
      const location = deps.callStack.location();
      current.set(
        path !== null && location !== null && pathKey(location.path) === pathKey(path)
          ? [currentLineDecoration(location)]
          : [],
      );
    };
    const follow = () => {
      // Breakpoints move with their line when text is inserted or deleted above them.
      const moves = ids.flatMap((id, index) => {
        const range = marks.getRange(index);
        return range ? [{ id, line: range.startLineNumber }] : [];
      });
      deps.breakpoints.moveLines(moves);
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
      editor.onMouseDown((event) => {
        if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
        const line = event.target.position.lineNumber;
        const path = pathOf(editor.getModel());
        if (path !== null) deps.breakpoints.toggle(path, line);
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
      current.clear();
    });
  };

  const created = monaco.editor.onDidCreateEditor(attach);
  for (const editor of monaco.editor.getEditors()) attach(editor);
  const refreshAll = () => {
    for (const refresh of refreshers) refresh();
  };
  const offBreakpoints = deps.breakpoints.subscribe(refreshAll);
  const offStack = deps.callStack.subscribe(refreshAll);

  return {
    dispose: () => {
      created.dispose();
      offBreakpoints();
      offStack();
      for (const detach of attached.values()) detach();
      attached.clear();
    },
  };
}
