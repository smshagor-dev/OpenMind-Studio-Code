import { useEffect, useState } from "react";
import * as monaco from "monaco-editor";

import { MonacoHost } from "../../editor/MonacoHost";
import { MONACO_THEME_MAP } from "../../editor/monacoThemes";

let counter = 0;

/**
 * A document an extension's file system provider served (a custom scheme such as `memfs:`), in a read-only editor:
 * its own model (never a file on disk, never saved), highlighted as its language. Milestone 18.
 */
export function VirtualTextPreview({ text, language }: { text: string; language: string }) {
  const [model] = useState(() => {
    counter += 1;
    const known = monaco.languages.getLanguages().some((l) => l.id === language);
    return monaco.editor.createModel(
      text,
      known ? language : "plaintext",
      monaco.Uri.parse(`openmind-virtual:/doc-${String(counter)}`),
    );
  });
  useEffect(() => {
    if (model.getValue() !== text) model.setValue(text);
  }, [model, text]);
  useEffect(
    () => () => {
      model.dispose();
    },
    [model],
  );
  const themeKind = document.documentElement.dataset.theme ?? "dark";
  return (
    <div className="file-preview__virtual">
      <MonacoHost
        model={model}
        theme={MONACO_THEME_MAP[themeKind] ?? "openmind-dark"}
        onEditorMounted={(editor) => {
          editor.updateOptions({ readOnly: true, domReadOnly: true });
          return () => undefined;
        }}
      />
    </div>
  );
}
