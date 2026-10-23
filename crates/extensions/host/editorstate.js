"use strict";

const key = editor => editor && (editor.id || editor.path);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function initialize(host, params) {
  host.state.visibleEditors = Array.isArray(params.visibleEditors) ? params.visibleEditors : undefined;
  host.state.editorBaseline = host.state.visibleEditors ? structuredClone(host.state.visibleEditors) : undefined;
}

/** Apply a coherent workbench snapshot before any extension observes its events. */
function update(host, params) {
  const previous = host.state.editorBaseline || host.state.visibleEditors || [];
  const before = new Map(previous.map(editor => [key(editor), editor]));
  const editors = Array.isArray(params.editors) ? params.editors : [];
  const oldActive = host.state.activeEditor;
  host.state.visibleEditors = editors;
  host.state.activeEditor = editors.find(editor => key(editor) === params.activeId) || null;
  host.state.editorBaseline = structuredClone(editors);
  if (!equal(previous.map(key), editors.map(key))) host.events.fire('visibleEditors', { editors });
  if (key(oldActive) !== key(host.state.activeEditor)) host.events.fire('activeEditor', { editor: host.state.activeEditor });
  for (const editor of editors) {
    const old = before.get(key(editor));
    if (!old) continue;
    if (!equal(old.selections, editor.selections)) host.events.fire('selectionChanged', { ...editor, kind: editor.selectionKind || 3 });
    if (old.tabSize !== editor.tabSize || old.insertSpaces !== editor.insertSpaces) host.events.fire('editorOptionsChanged', editor);
    if (old.viewColumn !== editor.viewColumn) host.events.fire('editorViewColumnChanged', editor);
    if (!equal(old.visibleRanges, editor.visibleRanges)) host.events.fire('editorVisibleRangesChanged', editor);
  }
}

module.exports = { initialize, update };
