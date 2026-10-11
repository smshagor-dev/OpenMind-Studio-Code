import * as monaco from "monaco-editor";

import type { PresencePublisher } from "../services/collab/presencePublisher";
import type { RemoteCursors } from "./remoteCursors";

/**
 * Connects every Monaco editor of this window to presence (Milestone 24, phase 7): the editor the user is in feeds the
 * publisher (focus, cursor/selection, a different model), and every editor shows other members' cursors.
 */
export function followEditors(publisher: PresencePublisher, cursors: RemoteCursors): () => void {
  const stops: (() => void)[] = [];
  const follow = (editor: monaco.editor.ICodeEditor): void => {
    const detach = cursors.attach(editor);
    const subscriptions = [
      editor.onDidFocusEditorWidget(() => {
        publisher.focus(editor);
      }),
      editor.onDidChangeCursorSelection(() => {
        publisher.moved(editor);
      }),
      editor.onDidChangeModel(() => {
        cursors.renderEditor(editor);
        publisher.moved(editor);
      }),
    ];
    const dispose = editor.onDidDispose(() => {
      detach();
      for (const s of subscriptions) s.dispose();
      dispose.dispose();
      publisher.forget(editor);
    });
    if (editor.hasWidgetFocus()) publisher.focus(editor);
    else publisher.moved(editor);
  };
  for (const editor of monaco.editor.getEditors()) follow(editor);
  const created = monaco.editor.onDidCreateEditor(follow);
  stops.push(() => {
    created.dispose();
  });
  return () => {
    for (const stop of stops) stop();
  };
}

/** The stylesheet that carries members' name labels (`::after` content); created on first use. */
export function labelStyle(): { set: (css: string) => void } {
  let element: HTMLStyleElement | null = null;
  return {
    set: (css) => {
      if (!element) {
        element = document.createElement("style");
        element.dataset.openmind = "collab-presence-labels";
        document.head.appendChild(element);
      }
      element.textContent = css;
    },
  };
}
