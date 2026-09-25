import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";

import { defineMonacoThemes } from "./monacoThemes";

// No custom `MonacoEnvironment.getWorker` is configured: this project's
// Vite 8 (Rolldown bundler) has a resolver bug bundling a web worker that
// imports from a node_modules package (works for monaco's own internal,
// same-package worker chunks; fails for one authored in our own source).
// Monaco's documented fallback for "no worker available" is to run
// synchronously on the main thread instead — a real, supported degraded
// mode, not a broken one. Nothing in Milestone 2's scope (editing,
// open/save, tabs) depends on the worker; language-service workers
// (ts/json/css/html) only matter once LSP-adjacent features land, by which
// point this bundler limitation should be revisited.
interface MonacoHostProps {
  model: monaco.editor.ITextModel | null;
  theme: string;
  /** Hands the created editor to the caller (which may return a teardown); keeps this component service-free. */
  onEditorMounted?: (editor: monaco.editor.IStandaloneCodeEditor) => () => void;
}

/**
 * Mounts and tears down a Monaco editor instance. This is the entire
 * extent of this component's job — it has no knowledge of documents, files,
 * dirty state, or IPC. All of that lives in the services; this just shows
 * whatever model it's handed.
 */
export function MonacoHost({ model, theme, onEditorMounted }: MonacoHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    defineMonacoThemes();
    const editor = monaco.editor.create(containerRef.current, {
      automaticLayout: true,
      theme,
      minimap: { enabled: true },
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 14,
      model,
    });
    editorRef.current = editor;
    const teardown = onEditorMounted?.(editor);
    return () => {
      teardown?.();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme/model changes are applied imperatively below, not by remounting the editor
  }, []);

  useEffect(() => {
    editorRef.current?.setModel(model);
  }, [model]);

  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [theme]);

  return <div ref={containerRef} className="monaco-host" />;
}
