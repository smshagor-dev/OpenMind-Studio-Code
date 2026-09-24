import * as monaco from "monaco-editor";
import { useEffect, useRef } from "react";

import { languageForPath } from "./languageForPath";

interface MonacoDiffHostProps {
  /** `null` = the file doesn't exist on that side (added / deleted). */
  original: string | null;
  modified: string | null;
  /** Only used to pick the syntax highlighting. */
  path: string;
  theme: string;
}

/**
 * Mounts a read-only Monaco side-by-side diff editor for two texts. Like
 * `MonacoHost` it is UI only: it shows the two strings it is handed and owns
 * the temporary models it creates for them.
 */
export function MonacoDiffHost({ original, modified, path, theme }: MonacoDiffHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      automaticLayout: true,
      theme,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 14,
    });
    editorRef.current = editor;
    return () => {
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the theme is applied by the effect below
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const language = languageForPath(path);
    const originalModel = monaco.editor.createModel(original ?? "", language);
    const modifiedModel = monaco.editor.createModel(modified ?? "", language);
    editor.setModel({ original: originalModel, modified: modifiedModel });
    return () => {
      editor.setModel(null);
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [original, modified, path]);

  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [theme]);

  return <div className="git-diff__editor" ref={containerRef} />;
}
