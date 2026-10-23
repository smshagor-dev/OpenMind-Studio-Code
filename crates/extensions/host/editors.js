'use strict';
// Documents, text editors and edits for OpenMind Studio's extension host (a VS Code API subset, written for this
// app): `TextDocument`, `TextEditor` (selections, `edit`, `revealRange`), `TextEditorEdit` and `WorkspaceEdit`. The
// application owns the text; the host keeps a mirror (`state.documents`, `state.activeEditor`) and sends edits back
// as requests. Edits change the open buffer only — nothing here writes a file.

const { permissionError, within, resolvedPath } = require('./guard.js');

const EndOfLine = Object.freeze({ LF: 1, CRLF: 2 });
const TextEditorRevealType = Object.freeze({ Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 });
const TextEditorSelectionChangeKind = Object.freeze({ Keyboard: 1, Mouse: 2, Command: 3 });

const { unsupportedError } = require('./unsupported.js');

/** Where every line starts and ends, counting the real line break characters (CRLF is two). */
function indexText(text) {
  const lines = [];
  let start = 0;
  const breaks = /\r\n|\r|\n/g;
  let match;
  while ((match = breaks.exec(text))) {
    lines.push({ start, end: match.index, next: match.index + match[0].length });
    start = match.index + match[0].length;
  }
  lines.push({ start, end: text.length, next: text.length });
  return lines;
}

function createEditing(types) {
  const { Position, Range, Selection, Uri } = types;

  function validatePosition(lines, position) {
    let line = Number.isFinite(position.line) ? Math.trunc(position.line) : 0;
    let character = Number.isFinite(position.character) ? Math.trunc(position.character) : 0;
    if (line < 0) return new Position(0, 0);
    if (line >= lines.length) {
      line = lines.length - 1;
      return new Position(line, lines[line].end - lines[line].start);
    }
    character = Math.max(0, Math.min(character, lines[line].end - lines[line].start));
    return new Position(line, character);
  }

  function offsetOf(lines, position) {
    const valid = validatePosition(lines, position);
    return lines[valid.line].start + valid.character;
  }

  function positionOf(lines, text, offset) {
    const clamped = Math.max(0, Math.min(Math.trunc(offset) || 0, text.length));
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lines[mid].start <= clamped) low = mid;
      else high = mid - 1;
    }
    return new Position(low, Math.min(clamped - lines[low].start, lines[low].end - lines[low].start));
  }

  /** A TextDocument that always reads the newest mirror of the file, even when the extension keeps the object. */
  function makeDocument(filePath, current, initial) {
    let last = current() || initial;
    const data = () => {
      const now = current();
      if (now) last = now;
      return last;
    };
    let cachedText;
    let cachedIndex;
    const view = () => {
      const text = String(data().text);
      if (text !== cachedText) {
        cachedText = text;
        cachedIndex = indexText(text);
      }
      return { text, lines: cachedIndex };
    };
    const doc = {
      get uri() {
        // A custom-scheme document (a file system provider's) is keyed by its Uri text.
        return /^[a-z][a-z0-9+.-]+:\/\//.test(filePath) ? Uri.parse(filePath) : Uri.file(filePath);
      },
      get fileName() {
        return filePath;
      },
      get languageId() {
        return data().languageId;
      },
      get version() {
        return data().version;
      },
      get isDirty() {
        return !!data().isDirty;
      },
      isUntitled: false,
      get isClosed() {
        return !current();
      },
      get lineCount() {
        return view().lines.length;
      },
      get eol() {
        return data().eol === EndOfLine.CRLF || (data().eol === undefined && view().text.includes('\r\n')) ? EndOfLine.CRLF : EndOfLine.LF;
      },
      getText(range) {
        const { text, lines } = view();
        if (!range) return text;
        const start = offsetOf(lines, range.start);
        const end = offsetOf(lines, range.end);
        return text.slice(Math.min(start, end), Math.max(start, end));
      },
      lineAt(lineOrPosition) {
        const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition && lineOrPosition.line;
        const { text, lines } = view();
        if (!Number.isInteger(line) || line < 0 || line >= lines.length) throw new Error('Illegal value for `line`');
        const info = lines[line];
        const lineText = text.slice(info.start, info.end);
        const firstNonWhitespace = lineText.search(/\S/);
        return {
          lineNumber: line,
          text: lineText,
          range: new Range(line, 0, line, lineText.length),
          rangeIncludingLineBreak: new Range(line, 0, line < lines.length - 1 ? line + 1 : line, line < lines.length - 1 ? 0 : lineText.length),
          firstNonWhitespaceCharacterIndex: firstNonWhitespace < 0 ? lineText.length : firstNonWhitespace,
          isEmptyOrWhitespace: firstNonWhitespace < 0,
        };
      },
      offsetAt(position) {
        return offsetOf(view().lines, position);
      },
      positionAt(offset) {
        const { text, lines } = view();
        return positionOf(lines, text, offset);
      },
      validatePosition(position) {
        return validatePosition(view().lines, position);
      },
      validateRange(range) {
        const { lines } = view();
        return new Range(validatePosition(lines, range.start), validatePosition(lines, range.end));
      },
      getWordRangeAtPosition(position) {
        const { text, lines } = view();
        const valid = validatePosition(lines, position);
        const lineText = text.slice(lines[valid.line].start, lines[valid.line].end);
        const pattern = /[A-Za-z0-9_$]+/g;
        let match;
        while ((match = pattern.exec(lineText))) {
          if (valid.character >= match.index && valid.character <= match.index + match[0].length) {
            return new Range(valid.line, match.index, valid.line, match.index + match[0].length);
          }
        }
        return undefined;
      },
    };
    return doc;
  }

  /** Collects the edits of one `TextEditor.edit` callback. */
  class TextEditorEdit {
    constructor(document) {
      this._document = document;
      this._edits = [];
      this._closed = false;
      this._eol = undefined;
    }
    _add(range, text) {
      if (this._closed) throw new Error('TextEditorEdit is only valid inside the edit callback.');
      const valid = this._document.validateRange(range);
      this._edits.push({ range: valid, text: text === undefined || text === null ? '' : String(text) });
    }
    replace(location, value) {
      this._add(location instanceof Position ? new Range(location, location) : location, value);
    }
    insert(location, value) {
      this._add(new Range(location, location), value);
    }
    delete(location) {
      this._add(location, '');
    }
    setEndOfLine(eol) {
      if (this._closed) throw new Error('TextEditorEdit is only valid inside the edit callback.');
      if (eol !== EndOfLine.LF && eol !== EndOfLine.CRLF) throw new TypeError('Invalid end-of-line value.');
      this._eol = eol;
    }
    _finish() {
      this._closed = true;
      return normalizeEdits(this._document, this._edits);
    }
  }

  /** Sorted, with overlapping ranges refused ("insert at the same point" twice keeps their order). */
  function normalizeEdits(document, edits) {
    const indexed = edits.map((edit, order) => ({ edit, order, start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end) }));
    indexed.sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
    for (let i = 1; i < indexed.length; i += 1) {
      if (indexed[i].start < indexed[i - 1].end) {
        throw new Error('Overlapping ranges are not allowed!');
      }
    }
    return indexed.map(({ edit }) => ({
      startLine: edit.range.start.line,
      startColumn: edit.range.start.character,
      endLine: edit.range.end.line,
      endColumn: edit.range.end.character,
      text: edit.text,
    }));
  }

  class WorkspaceEdit {
    constructor() {
      this._files = new Map();
      this._notebooks = new Map();
    }
    _bucket(uri) {
      const key = uri.toString();
      if (!this._files.has(key)) this._files.set(key, { uri, edits: [] });
      return this._files.get(key);
    }
    replace(uri, range, newText) {
      this._bucket(uri).edits.push({ range, newText: String(newText) });
    }
    insert(uri, position, newText) {
      this.replace(uri, new Range(position, position), newText);
    }
    delete(uri, range) {
      this.replace(uri, range, '');
    }
    has(uri) {
      return this._files.has(uri.toString());
    }
    get(uri) {
      const bucket = this._files.get(uri.toString());
      return bucket ? bucket.edits.map((edit) => ({ range: edit.range, newText: edit.newText, ...(edit.newEol !== undefined ? { newEol: edit.newEol } : {}) })) : [];
    }
    set(uri, edits) {
      const values = [...(edits || [])].map(value => {
        if (!Array.isArray(value)) return value;
        if (value[1]?.needsConfirmation) throw unsupportedError('WorkspaceEditEntryMetadata.needsConfirmation');
        return value[0];
      });
      const isNotebook = value => value instanceof require('./notebooks.js').NotebookEdit;
      if (values.some(isNotebook)) {
        if (!values.every(isNotebook)) throw new TypeError('Cannot mix text and notebook edits for one URI.');
        this._notebooks.set(uri.toString(), { uri, edits: values }); this._files.delete(uri.toString()); return;
      }
      this._notebooks.delete(uri.toString());
      const bucket = this._bucket(uri);
      bucket.edits = values.map(edit => ({ range: edit.range, newText: String(edit.newText), ...(edit.newEol !== undefined ? { newEol: edit.newEol } : {}) }));
    }

    entries() {
      return [...this._files.values()].map((bucket) => [bucket.uri, this.get(bucket.uri)]);
    }
    get size() {
      return new Set([...this._files.keys(), ...this._notebooks.keys()]).size;
    }
    createFile() {
      throw unsupportedError('WorkspaceEdit.createFile');
    }
    deleteFile() {
      throw unsupportedError('WorkspaceEdit.deleteFile');
    }
    renameFile() {
      throw unsupportedError('WorkspaceEdit.renameFile');
    }
  }

  function selectionFromWire(wire) {
    return new Selection(wire.anchorLine, wire.anchorColumn, wire.activeLine, wire.activeColumn);
  }

  function selectionToWire(selection) {
    return {
      anchorLine: selection.anchor.line,
      anchorColumn: selection.anchor.character,
      activeLine: selection.active.line,
      activeColumn: selection.active.character,
    };
  }

  return { makeDocument, TextEditorEdit, WorkspaceEdit, normalizeEdits, selectionFromWire, selectionToWire, validatePosition, indexText };
}

/**
 * The editor/edit part of one extension's `vscode` API. `host` is the host's shared state, `ext` the extension,
 * `parts` what vscode.js already has (`need`, `track`, `namespace`, the value classes).
 */
function createEditorApi({ host, ext, need, namespace, types, asExtension, Disposable, track }) {
  const { state, request, notify } = host;
  const { Position, Range, Selection } = types;
  const editing = createEditing(types);
  const documents = new Map();
  if (track) track(host.events.on('documentWillClose')(data => {
    const cached = documents.get(data?.path);
    if (cached) void cached.version;
  }));
  const editors = new Map();
  const hiddenEditors = new Map();
  const collectedEditors = new FinalizationRegistry(({ key, reference }) => {
    if (hiddenEditors.get(key) === reference) hiddenEditors.delete(key);
  });
  const pendingEditors = new Set();
  let disposed = false;
  if (track) track(new Disposable(() => { disposed = true; for (const cancel of [...pendingEditors]) cancel(); }));

  function document(data) {
    if (!data) return undefined;
    const key = data.path;
    if (!documents.has(key)) {
      const doc = editing.makeDocument(key, () => state.documents.get(key), data);
      /** Saves the open document (`workspaceWrite`); a custom-scheme document can't be saved from here. */
      doc.save = async () => {
        need('workspaceWrite');
        const current = state.documents.get(key);
        if (!current || current.virtual) return false;
        const answer = await request('workspace/saveDocument', { extension: ext.id, path: key });
        return !!(answer && answer.saved);
      };
      documents.set(key, doc);
    }
    return documents.get(key);
  }

  /** With a folder open, an open file outside it is the outside-workspace permission's business. */
  function checkEditable(filePath) {
    const target = resolvedPath(filePath);
    if (state.workspaceFolders.length > 0 && !state.workspaceFolders.some((folder) => within(resolvedPath(folder.path), target))) {
      if (!(ext.permissions || []).includes('filesystemOutsideWorkspace')) throw permissionError('filesystemOutsideWorkspace');
    }
  }

  async function sendEdits(filePath, version, edits, options) {
    const result = await request('editor/applyEdits', { extension: ext.id, path: filePath, version, edits, ...options });
    if (!result || result.applied !== true) {
      console.error(`Edit not applied to ${filePath}: ${(result && result.reason) || 'the application refused it'}`);
      return false;
    }
    return true;
  }

  function makeEditor(filePath, editorId, initial) {
    let previous = initial;
    const retainedDocument = document(state.documents.get(filePath));
    const active = () => {
      const current = editorId ? state.visibleEditors?.find(value => value.id === editorId) || (state.activeEditor?.id === editorId ? state.activeEditor : null)
        : state.activeEditor?.path === filePath ? state.activeEditor : null;
      if (current) previous = current;
      return current || previous;
    };
    const wireSelections = () => {
      const now = active();
      return now && Array.isArray(now.selections) && now.selections.length ? now.selections : [{ anchorLine: 0, anchorColumn: 0, activeLine: 0, activeColumn: 0 }];
    };
    const setSelections = (list) => {
      const selections = list.map((selection) => (selection instanceof Selection ? selection : new Selection(selection.start, selection.end)));
      const now = active();
      if (now) now.selections = selections.map(editing.selectionToWire);
      notify('editor/setSelections', { extension: ext.id, path: filePath, ...(editorId ? { editorId } : {}), selections: selections.map(editing.selectionToWire) });
    };
    function setOptions(value) {
      if (!value || typeof value !== 'object') throw new TypeError('Editor options must be an object.');
      for (const key of Object.keys(value)) if (!['tabSize', 'insertSpaces'].includes(key)) throw unsupportedError(`TextEditorOptions.${key}`);
      const { tabSize, insertSpaces } = value;
      if (tabSize !== undefined && tabSize !== 'auto' && (!Number.isInteger(tabSize) || tabSize < 1 || tabSize > 1000)) throw new TypeError('Invalid editor tab size.');
      if (insertSpaces !== undefined && insertSpaces !== 'auto' && typeof insertSpaces !== 'boolean') throw new TypeError('Invalid editor indentation option.');
      notify('editor/setOptions', { extension: ext.id, path: filePath, ...(editorId ? { editorId } : {}), options: { tabSize, insertSpaces } });
    }
    const editorOptions = {};
    for (const key of ['tabSize', 'insertSpaces']) Object.defineProperty(editorOptions, key, {
      enumerable: true,
      get() { return active()?.[key] ?? (key === 'tabSize' ? 4 : true); },
      set(value) { setOptions({ [key]: value }); },
    });
    const target = {
      get document() {
        return document(state.documents.get(filePath)) || retainedDocument;
      },
      get selection() {
        return editing.selectionFromWire(wireSelections()[0]);
      },
      set selection(value) {
        setSelections([value]);
      },
      get selections() {
        return wireSelections().map(editing.selectionFromWire);
      },
      set selections(value) {
        setSelections(value);
      },
      get options() {
        return editorOptions;
      },
      set options(value) { setOptions(value); },
      get visibleRanges() {
        return (active()?.visibleRanges || []).map(range => new Range(range.startLine, range.startColumn, range.endLine, range.endColumn));
      },
      get viewColumn() {
        return active()?.viewColumn ?? 1;
      },
      async edit(callback, options) {
        need('workspaceWrite');
        if (editorId && !state.visibleEditors?.some(value => value.id === editorId)) return false;
        const doc = state.documents.get(filePath);
        if (!doc) return false;
        checkEditable(filePath);
        const view = document(doc);
        const builder = new editing.TextEditorEdit(view);
        const version = doc.version;
        try { callback(builder); } finally { builder._closed = true; }
        const edits = builder._finish();
        if (edits.length === 0 && builder._eol === undefined) return true;
        for (const key of ['undoStopBefore', 'undoStopAfter']) if (options?.[key] !== undefined && typeof options[key] !== 'boolean') throw new TypeError('Undo options must be boolean.');
        return sendEdits(filePath, version, edits, { eol: builder._eol, undoStopBefore: options?.undoStopBefore, undoStopAfter: options?.undoStopAfter });
      },
      async insertSnippet(snippet, location, options) {
        need('workspaceWrite');
        if (editorId && !state.visibleEditors?.some(value => value.id === editorId)) return false;
        const doc = state.documents.get(filePath);
        if (!doc) return false;
        checkEditable(filePath);
        if (!snippet || typeof snippet.value !== 'string') throw new TypeError('A SnippetString is required.');
        for (const key of ['undoStopBefore', 'undoStopAfter']) if (options?.[key] !== undefined && typeof options[key] !== 'boolean') throw new TypeError('Undo options must be boolean.');
        const locations = location === undefined ? undefined : Array.isArray(location) ? location : [location];
        const ranges = locations?.map(value => {
          const start = value?.start ?? value, end = value?.end ?? value;
          if (![start?.line, start?.character, end?.line, end?.character].every(n => Number.isInteger(n) && n >= 0)) throw new TypeError('A snippet location must be a Position or Range.');
          return { startLine: start.line, startColumn: start.character, endLine: end.line, endColumn: end.character };
        });
        if (ranges?.length === 0) return true;
        const result = await request('editor/insertSnippet', {
          extension: ext.id, path: filePath, version: doc.version,
          ...(editorId ? { editorId } : {}), snippet: snippet.value, ranges,
          undoStopBefore: options?.undoStopBefore, undoStopAfter: options?.undoStopAfter,
        });
        return result?.applied === true;
      },
      revealRange(range, revealType) {
        notify('editor/revealRange', {
          extension: ext.id,
          path: filePath,
          ...(editorId ? { editorId } : {}),
          range: { startLine: range.start.line, startColumn: range.start.character, endLine: range.end.line, endColumn: range.end.character },
          type: revealType || 0,
        });
      },
    };
    return namespace('TextEditor', target);
  }

  function editor(data) {
    if (!data) return undefined;
    const key = data.id || data.path;
    if (!editors.has(key)) {
      const retained = hiddenEditors.get(key)?.deref();
      if (retained) collectedEditors.unregister(retained);
      hiddenEditors.delete(key);
      editors.set(key, retained || makeEditor(data.path, data.id, data));
    }
    return editors.get(key);
  }

  const activeEditor = () => editor(state.activeEditor);
  const visibleEditors = () => (state.visibleEditors || (state.activeEditor ? [state.activeEditor] : [])).map(editor);
  if (track) track(host.events.on('visibleEditors')(() => {
    const visible = new Set((state.visibleEditors || []).map(value => value.id || value.path));
    for (const [key, value] of editors) if (!visible.has(key)) {
      const reference = new WeakRef(value);
      hiddenEditors.set(key, reference);
      collectedEditors.register(value, { key, reference }, value);
      editors.delete(key);
    }
  }));

  async function showEditor(filePath, preserveFocus) {
    if (disposed) throw new Error('The extension stopped before its editor became visible.');
    let cancel;
    const stopped = new Promise((resolve, reject) => { cancel = () => reject(new Error('The extension stopped before its editor became visible.')); });
    pendingEditors.add(cancel);
    try {
      return await Promise.race([
        request('ui/showTextDocument', { extension: ext.id, path: filePath, preserveFocus: !!preserveFocus }).then(() => editorForPath(filePath)),
        stopped,
      ]);
    } finally { pendingEditors.delete(cancel); }
  }

  function editorForPath(filePath) {
    if (disposed) return Promise.reject(new Error('The extension stopped before its editor became visible.'));
    const canonical = value => /^[a-z]:/i.test(value) ? value.replace(/\\/g, '/').toLowerCase() : require('path').resolve(value);
    const find = () => {
      const visible = state.visibleEditors || (state.activeEditor ? [state.activeEditor] : []);
      const target = visible.find(value => value === state.activeEditor && canonical(value.path) === canonical(filePath))
        || visible.find(value => canonical(value.path) === canonical(filePath));
      return target && editor(target);
    };
    const existing = find();
    if (existing || state.visibleEditors === undefined) return Promise.resolve(existing || activeEditor());
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return; settled = true; clearTimeout(timer); listener.dispose(); pendingEditors.delete(cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => finish(undefined, new Error('The extension stopped before its editor became visible.'));
      const listener = host.events.on('visibleEditors')(() => { const target = find(); if (target) finish(target); });
      const timer = setTimeout(() => finish(undefined, new Error('The requested text editor did not become visible.')), 10000);
      pendingEditors.add(cancel);
    });
  }

  async function applyEdit(edit) {
    need('workspaceWrite');
    if (edit._notebooks?.size) {
      if (edit.entries().some(([, edits]) => edits.length)) throw unsupportedError('workspace.applyEdit.mixedNotebookAndText');
      return require('./notebooks.js').applyEdits(host, [...edit._notebooks.values()], checkEditable);
    }
    const files = [];
    for (const [uri, list] of edit.entries()) {
      const filePath = uri.fsPath;
      const doc = state.documents.get(filePath);
      if (!doc) {
        console.error(`workspace.applyEdit: ${filePath} isn't open, and only open documents can be edited for now.`);
        return false;
      }
      checkEditable(filePath);
      const view = document(doc);
      const edits = editing.normalizeEdits(
        view,
        list.filter(item => item.newEol === undefined).map((item) => ({ range: view.validateRange(item.range), text: item.newText })),
      );
      const eol = list.filter(item => item.newEol !== undefined).at(-1)?.newEol;
      if (eol !== undefined && eol !== EndOfLine.LF && eol !== EndOfLine.CRLF) throw new TypeError('Invalid end-of-line value.');
      files.push({ path: filePath, version: doc.version, edits, ...(eol !== undefined ? { eol } : {}) });
    }
    if (files.length === 0) return true;
    const result = await request('editor/applyWorkspaceEdit', { extension: ext.id, files });
    if (!result || result.applied !== true) {
      console.error(`workspace.applyEdit not applied: ${(result && result.reason) || 'the application refused it'}`);
      return false;
    }
    return true;
  }

  const selectionEvent = (listener, thisArg, disposables) =>
    host.events.on('selectionChanged')(
      asExtension((data) => {
        const target = editor(data);
        if (target) listener.call(thisArg, { textEditor: target, selections: target.selections, kind: data.kind || TextEditorSelectionChangeKind.Command });
      }),
      thisArg,
      disposables,
    );

  return { document, editor, activeEditor, visibleEditors, showEditor, applyEdit, selectionEvent, WorkspaceEdit: editing.WorkspaceEdit, Disposable, Position, Range };
}

module.exports = { createEditorApi, EndOfLine, TextEditorRevealType, TextEditorSelectionChangeKind };

