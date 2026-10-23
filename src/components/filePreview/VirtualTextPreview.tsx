import { useEffect, useRef, useState } from "react";
import type * as monaco from "monaco-editor";

import {
  acquireModel as acquire,
  markLive,
  releaseModel as release,
  wasLive,
} from "../../editor/collabModels";
import { MonacoHost } from "../../editor/MonacoHost";
import { MONACO_THEME_MAP } from "../../editor/monacoThemes";
import { attachRevisionEditor } from "../../services/editorMenu/revisionHook";

/**
 * A custom-scheme document in an editor that is read-only unless it is a live collaborative document this member may
 * change: an extension's file system provider (`memfs:`, Milestone 18) or a
 * collaboration room's remote snapshot (`omcollab:`, Milestone 24). Never a file on disk, never saved. A remote
 * document has one Monaco model per identity, shared by every view of it and disposed with the last one.
 */
export function VirtualTextPreview({
  text,
  language,
  uri = null,
  documentUri = null,
  readOnly = true,
  live = false,
}: {
  text: string;
  language: string;
  uri?: string | null;
  /** The tab's own address (`git-revision:/…` for a Git revision, which gets the app's read-only menu). */
  documentUri?: string | null;
  /** False while this member may edit a live collaborative document. */
  readOnly?: boolean;
  /** The text is a live collaborative document: the model follows the CRDT, never the snapshot text. */
  live?: boolean;
}) {
  const [model] = useState(() => acquire(uri, text, language));
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  useEffect(() => {
    // Once live, the text is the CRDT's: an unavailable (disconnected) document keeps it; the snapshot never returns.
    if (live) markLive(model);
    else if (!wasLive(model) && model.getValue() !== text) model.setValue(text);
  }, [model, text, live]);
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly });
  }, [readOnly]);
  useEffect(
    () => () => {
      release(uri, model);
    },
    [uri, model],
  );
  const themeKind = document.documentElement.dataset.theme ?? "dark";
  return (
    <div className="file-preview__virtual">
      <MonacoHost
        model={model}
        readOnly={readOnly}
        theme={MONACO_THEME_MAP[themeKind] ?? "openmind-dark"}
        onEditorMounted={(editor) => {
          editorRef.current = editor;
          editor.updateOptions({ readOnly, domReadOnly: readOnly });
          // A Git revision gets the app's context menu with its read-only actions.
          const detachMenu = attachRevisionEditor(editor, documentUri);
          return () => {
            detachMenu?.();
            editorRef.current = null;
          };
        }}
      />
    </div>
  );
}

