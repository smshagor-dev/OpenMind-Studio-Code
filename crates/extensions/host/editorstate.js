"use strict";

const keys = ['tabSize', 'indentSize', 'insertSpaces', 'cursorStyle', 'lineNumbers'];
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Editor options must be an object.');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`Unsupported TextEditorOptions.${key}`);
  const { tabSize, indentSize, insertSpaces, cursorStyle, lineNumbers } = value;
  const size = n => Number.isInteger(n) && n >= 1 && n <= 1000;
  if (tabSize !== undefined && tabSize !== 'auto' && !size(tabSize)) throw new TypeError('Invalid editor tab size.');
  if (indentSize !== undefined && indentSize !== 'tabSize' && !size(indentSize)) throw new TypeError('Invalid editor indent size.');
  if (insertSpaces !== undefined && insertSpaces !== 'auto' && typeof insertSpaces !== 'boolean') throw new TypeError('Invalid editor indentation option.');
  if (cursorStyle !== undefined && (!Number.isInteger(cursorStyle) || cursorStyle < 1 || cursorStyle > 6)) throw new TypeError('Invalid editor cursor style.');
  if (lineNumbers !== undefined && (!Number.isInteger(lineNumbers) || lineNumbers < 0 || lineNumbers > 2)) throw new TypeError('Invalid editor line numbers.');
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
function resolved(value = {}) {
  const tabSize = typeof value.tabSize === 'number' ? value.tabSize : 4;
  return { tabSize, indentSize: typeof value.indentSize === 'number' ? value.indentSize : tabSize,
    insertSpaces: typeof value.insertSpaces === 'boolean' ? value.insertSpaces : true,
    cursorStyle: value.cursorStyle ?? 1, lineNumbers: value.lineNumbers ?? 1 };
}


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
    if (keys.some(key => resolved(old)[key] !== resolved(editor)[key])) host.events.fire('editorOptionsChanged', editor);
    if (old.viewColumn !== editor.viewColumn) host.events.fire('editorViewColumnChanged', editor);
    if (!equal(old.visibleRanges, editor.visibleRanges)) host.events.fire('editorVisibleRangesChanged', editor);
  }
}

module.exports = { initialize, update, optionKeys: keys, validateOptions: validate, resolvedOptions: resolved };
