import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";

import { MONACO_THEME_MAP } from "../../editor/monacoThemes";

let counter = 0;

/**
 * One cell's source in a small Monaco editor that grows with its text (UI only: every change is handed to
 * `onChange`, the notebook service keeps the text). Its model is its own — never a file, never saved by itself.
 */
export function CellEditor({
  source,
  language,
  label,
  onChange,
  onRun,
}: {
  source: string;
  language: string;
  label: string;
  onChange: (text: string) => void;
  onRun?: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const changed = useRef(onChange);
  const run = useRef(onRun);
  useEffect(() => {
    changed.current = onChange;
    run.current = onRun;
  });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    counter += 1;
    const known = monaco.languages.getLanguages().some((l) => l.id === language);
    const model = monaco.editor.createModel(
      source,
      known ? language : "plaintext",
      monaco.Uri.parse(`openmind-notebook-cell:/cell-${String(counter)}`),
    );
    const theme =
      MONACO_THEME_MAP[document.documentElement.dataset.theme ?? "dark"] ?? "openmind-dark";
    const editor = monaco.editor.create(element, {
      model,
      theme,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      lineNumbers: "on",
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 13,
      ariaLabel: label,
      scrollbar: { alwaysConsumeMouseWheel: false },
      overviewRulerLanes: 0,
    });
    const fit = () => {
      element.style.height = `${String(Math.min(2000, Math.max(38, editor.getContentHeight())))}px`;
      editor.layout();
    };
    fit();
    const offs = [
      editor.onDidContentSizeChange(fit),
      model.onDidChangeContent(() => {
        changed.current(model.getValue());
      }),
      editor.addAction({
        id: "notebook.runCell",
        label: "Run Cell",
        keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter],
        run: () => {
          run.current?.();
        },
      }),
    ];
    return () => {
      for (const off of offs) off.dispose();
      editor.dispose();
      model.dispose();
    };
    // The editor is created once per cell; later text comes from the editor itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div className="notebook__editor" ref={host} />;
}
