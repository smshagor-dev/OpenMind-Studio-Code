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
        return view().text.includes('\r\n') ? EndOfLine.CRLF : EndOfLine.LF;
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
    setEndOfLine() {
      throw unsupportedError('TextEditorEdit.setEndOfLine');
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
      return bucket ? bucket.edits.map((edit) => ({ range: edit.range, newText: edit.newText })) : [];
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
      bucket.edits = values.map(edit => ({ range: edit.range, newText: String(edit.newText) }));
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
function createEditorApi({ host, ext, need, namespace, types, asExtension, Disposable }) {
  const { state, request, notify } = host;
  const { Position, Range, Selection } = types;
  const editing = createEditing(types);
  const documents = new Map();
  const editors = new Map();

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

  async function sendEdits(filePath, version, edits) {
    const result = await request('editor/applyEdits', { extension: ext.id, path: filePath, version, edits });
    if (!result || result.applied !== true) {
      console.error(`Edit not applied to ${filePath}: ${(result && result.reason) || 'the application refused it'}`);
      return false;
    }
    return true;
  }

  function makeEditor(filePath) {
    const active = () => (state.activeEditor && state.activeEditor.path === filePath ? state.activeEditor : null);
    const wireSelections = () => {
      const now = active();
      return now && Array.isArray(now.selections) && now.selections.length ? now.selections : [{ anchorLine: 0, anchorColumn: 0, activeLine: 0, activeColumn: 0 }];
    };
    const setSelections = (list) => {
      const selections = list.map((selection) => (selection instanceof Selection ? selection : new Selection(selection.start, selection.end)));
      const now = active();
      if (now) now.selections = selections.map(editing.selectionToWire);
      notify('editor/setSelections', { extension: ext.id, path: filePath, selections: selections.map(editing.selectionToWire) });
    };
    const target = {
      get document() {
        return document(state.documents.get(filePath));
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
        const now = active();
        return { tabSize: (now && now.tabSize) || 4, insertSpaces: now ? now.insertSpaces !== false : true };
      },
      get viewColumn() {
        return 1;
      },
      async edit(callback, options) {
        const doc = state.documents.get(filePath);
        if (!doc) return false;
        checkEditable(filePath);
        const view = document(doc);
        const builder = new editing.TextEditorEdit(view);
        callback(builder);
        const edits = builder._finish();
        if (edits.length === 0) return true;
        void options;
        return sendEdits(filePath, doc.version, edits);
      },
      revealRange(range, revealType) {
        notify('editor/revealRange', {
          extension: ext.id,
          path: filePath,
          range: { startLine: range.start.line, startColumn: range.start.character, endLine: range.end.line, endColumn: range.end.character },
          type: revealType || 0,
        });
      },
    };
    return namespace('TextEditor', target);
  }

  function editor(data) {
    if (!data) return undefined;
    if (!editors.has(data.path)) editors.set(data.path, makeEditor(data.path));
    return editors.get(data.path);
  }

  const activeEditor = () => editor(state.activeEditor);

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
        list.map((item) => ({ range: view.validateRange(item.range), text: item.newText })),
      );
      files.push({ path: filePath, version: doc.version, edits });
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
        const target = editor({ path: data.path });
        if (target) listener({ textEditor: target, selections: target.selections, kind: TextEditorSelectionChangeKind.Command });
      }),
      thisArg,
      disposables,
    );

  return { document, editor, activeEditor, applyEdit, selectionEvent, WorkspaceEdit: editing.WorkspaceEdit, Disposable, Position, Range };
}

module.exports = { createEditorApi, EndOfLine, TextEditorRevealType, TextEditorSelectionChangeKind };

