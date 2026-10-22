'use strict';
// The `vscode` module for OpenMind Studio's extension host: a compatible SUBSET of the VS Code API, written
// for this app (no VS Code source). Anything outside the subset fails with a clear message instead of
// pretending to work: "VS Code API '<name>' is not supported by OpenMind Studio yet."

const path = require('path');
const { permissionError, within } = require('./guard.js');
const { createTreeApi, TreeItem, TreeItemCollapsibleState, ThemeIcon } = require('./treeviews.js');
const { createEditorApi, EndOfLine, TextEditorRevealType, TextEditorSelectionChangeKind } = require('./editors.js');
const { createStatusBarApi, StatusBarAlignment, ThemeColor } = require('./statusbar.js');
const { createWebviewApi } = require('./webviews.js');
const { createTerminalApi } = require('./terminals.js');
const tasksModule = require('./tasks.js');
const { createWorkspaceApi, RelativePattern } = require('./workspace.js');
const { createLanguagesApi, TextEdit } = require('./languages.js');
const { FileType, FileSystemError } = require('./fsprovider.js');

// Called with the message whenever an unsupported API is used (the host logs it, attributed to the extension).
const { setReporter: setUnsupportedReporter, unsupportedError } = require('./unsupported.js');

const IGNORED = new Set(['__esModule', 'then', 'toJSON', 'inspect', 'constructor', 'prototype', 'valueOf', 'toString']);

function unsupported(name) {
  return new Proxy(function unsupportedApi() {}, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || IGNORED.has(prop)) return undefined;
      return unsupported(name ? `${name}.${prop}` : String(prop));
    },
    apply() {
      throw unsupportedError(name);
    },
    construct() {
      throw unsupportedError(name);
    },
  });
}

/** A namespace whose unknown members are "not supported" stubs. */
function namespace(name, members) {
  return new Proxy(members, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || IGNORED.has(prop) || prop in target) return Reflect.get(target, prop, receiver);
      return unsupported(name ? `${name}.${prop}` : String(prop));
    },
  });
}

// ---- basics ------------------------------------------------------------------------------------------------------

class Disposable {
  constructor(callOnDispose) {
    this._callOnDispose = callOnDispose;
  }
  static from(...disposables) {
    return new Disposable(() => {
      for (const disposable of disposables) disposable && disposable.dispose && disposable.dispose();
    });
  }
  dispose() {
    const call = this._callOnDispose;
    this._callOnDispose = undefined;
    if (call) call();
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener, thisArg, disposables) => {
      const bound = thisArg ? listener.bind(thisArg) : listener;
      this._listeners.add(bound);
      const disposable = new Disposable(() => this._listeners.delete(bound));
      if (Array.isArray(disposables)) disposables.push(disposable);
      return disposable;
    };
  }
  fire(data) {
    for (const listener of [...this._listeners]) {
      try {
        listener(data);
      } catch (error) {
        console.error(`Error in an event listener: ${error && error.stack ? error.stack : error}`);
      }
    }
  }
  dispose() {
    this._listeners.clear();
  }
}

/** Named events the host itself fires (documents, configuration...). */
function createEventHub() {
  const emitters = new Map();
  const emitter = (name) => {
    if (!emitters.has(name)) emitters.set(name, new EventEmitter());
    return emitters.get(name);
  };
  return { on: (name) => emitter(name).event, fire: (name, payload) => emitter(name).fire(payload) };
}

class Uri {
  constructor(scheme, authority, uriPath, query, fragment) {
    this.scheme = scheme;
    this.authority = authority || '';
    this.path = uriPath || '';
    this.query = query || '';
    this.fragment = fragment || '';
  }
  static file(fsPath) {
    let normalized = String(fsPath).replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(normalized)) normalized = `/${normalized}`;
    return new Uri('file', '', normalized, '', '');
  }
  static parse(value) {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(String(value));
    if (!match) return Uri.file(value);
    const decode = (value) => decodeURIComponent(value || '');
    return new Uri(match[1], decode(match[2]), decode(match[3]), decode(match[4]), decode(match[5]));
  }
  static joinPath(base, ...segments) {
    return base.with({ path: path.posix.join(base.path, ...segments) });
  }
  get fsPath() {
    let value = this.path;
    if (/^\/[a-zA-Z]:/.test(value)) value = value.slice(1);
    return process.platform === 'win32' ? value.replace(/\//g, '\\') : value;
  }
  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString() {
    const encoded = encodeURI(this.path).replace(/^\/([a-zA-Z]):/, '/$1%3A');
    return `${this.scheme}://${this.authority}${encoded}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
  }
  toJSON() {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath };
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isEqual(other) {
    return this.line === other.line && this.character === other.character;
  }
  isBefore(other) {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isAfter(other) {
    return !this.isEqual(other) && !this.isBefore(other);
  }
  isBeforeOrEqual(other) {
    return !this.isAfter(other);
  }
  isAfterOrEqual(other) {
    return !this.isBefore(other);
  }
  compareTo(other) {
    return this.isBefore(other) ? -1 : this.isAfter(other) ? 1 : 0;
  }
  translate(lineDelta = 0, characterDelta = 0) {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
  with(line = this.line, character = this.character) {
    return new Position(line, character);
  }
}

class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else if (b.isBefore(a)) {
      this.start = b;
      this.end = a;
    } else {
      this.start = a;
      this.end = b;
    }
  }
  get isEmpty() {
    return this.start.isEqual(this.end);
  }
  get isSingleLine() {
    return this.start.line === this.end.line;
  }
  contains(value) {
    const position = value instanceof Range ? value.start : value;
    const end = value instanceof Range ? value.end : value;
    return !position.isBefore(this.start) && !end.isAfter(this.end);
  }
  isEqual(other) {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
  intersection(other) {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(other) {
    return new Range(this.start.isBefore(other.start) ? this.start : other.start, this.end.isAfter(other.end) ? this.end : other.end);
  }
  with(start = this.start, end = this.end) {
    return new Range(start, end);
  }
}

class Selection extends Range {
  // The anchor is where the selection started, the active end is the cursor: a reversed selection keeps both.
  constructor(a, b, c, d) {
    const anchor = typeof a === 'number' ? new Position(a, b) : a;
    const active = typeof a === 'number' ? new Position(c, d) : b;
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
  get isReversed() {
    return this.anchor.isAfter(this.active);
  }
}

class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}

const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

class Diagnostic {
  constructor(range, message, severity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

class MarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = String(value);
    this.isTrusted = false;
    this.supportHtml = false;
    this.supportThemeIcons = !!supportThemeIcons;
    this.baseUri = undefined;
  }
  appendText(text) {
    // Text is literal: escape Markdown punctuation and prevent injecting links.
    const punctuation = new Set([92, 96, 42, 95, 123, 125, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62, 124]);
    this.value += [...String(text)].map((char) =>
      punctuation.has(char.charCodeAt(0)) ? String.fromCharCode(92) + char : char
    ).join('');
    return this;
  }
  appendMarkdown(text) {
    this.value += String(text);
    return this;
  }
  appendCodeblock(code, language = '') {
    const raw = String(code);
    const fences = raw.match(/`+/g) || [];
    const size = Math.max(3, ...fences.map((fence) => fence.length + 1));
    const fence = '`'.repeat(size);
    const safeLanguage = String(language).replace(/[^a-zA-Z0-9_+#-]/g, '');
    this.value += '\n' + fence + safeLanguage + '\n' + raw + '\n' + fence + '\n';
    return this;
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

const CompletionItemKind = {
  Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9,
  Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19,
  Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24,
};

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}

class CompletionList {
  constructor(items = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

class SnippetString {
  constructor(value = '') { this.value = String(value); this._tabstop = 1; }
  static escape(value, special = [92, 36, 125]) {
    return [...String(value)].map((char) =>
      special.includes(char.charCodeAt(0)) ? String.fromCharCode(92) + char : char
    ).join('');
  }
  static index(number) {
    if (!Number.isInteger(number) || number < 0) throw new TypeError('Invalid snippet tabstop');
    return number;
  }
  appendText(value) {
    this.value += SnippetString.escape(value);
    return this;
  }
  appendTabstop(number = this._tabstop++) {
    this.value += String.fromCharCode(36) + SnippetString.index(number);
    return this;
  }
  appendPlaceholder(value, number = this._tabstop++) {
    const text = typeof value === 'function' ? value(new SnippetString()).value : SnippetString.escape(value);
    this.value += String.fromCharCode(36, 123) + SnippetString.index(number) + ':' + text + '}';
    return this;
  }
  appendChoice(values, number = this._tabstop++) {
    if (!Array.isArray(values) || values.length === 0) throw new TypeError('Snippet choices required');
    const choices = values.map((value) => SnippetString.escape(value, [92, 124, 44, 125]));
    this.value += String.fromCharCode(36, 123) + SnippetString.index(number) + '|' + choices.join(',') + '|}';
    return this;
  }
  appendVariable(name, defaultValue) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError('Invalid snippet variable');
    }
    this.value += defaultValue === undefined
      ? String.fromCharCode(36) + name
      : String.fromCharCode(36, 123) + name + ':' + SnippetString.escape(defaultValue) + '}';
    return this;
  }
}

class CancellationTokenSource {
  constructor() {
    const emitter = new EventEmitter();
    this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
    this._emitter = emitter;
    this._disposed = false;
  }
  cancel() {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this._emitter.fire();
  }
  dispose(cancel = false) {
    if (this._disposed) return;
    if (cancel) this.cancel();
    this._disposed = true;
    this._emitter.dispose();
  }
}

// Value types shared by language tooling extensions. They are usable even when a
// corresponding provider contribution is not yet implemented by the workbench.
class CodeActionKind {
  constructor(value = '') { this.value = value; }
  append(part) { return new CodeActionKind(this.value ? this.value + '.' + part : part); }
  contains(other) {
    const value = other instanceof CodeActionKind ? other.value : String(other);
    return !this.value || value === this.value || value.startsWith(this.value + '.');
  }
  intersects(other) {
    const value = other instanceof CodeActionKind ? other.value : String(other);
    return this.contains(value) || new CodeActionKind(value).contains(this);
  }
}
CodeActionKind.Empty = new CodeActionKind('');
CodeActionKind.QuickFix = new CodeActionKind('quickfix');
CodeActionKind.Refactor = new CodeActionKind('refactor');
CodeActionKind.RefactorExtract = new CodeActionKind('refactor.extract');
CodeActionKind.RefactorInline = new CodeActionKind('refactor.inline');
CodeActionKind.RefactorRewrite = new CodeActionKind('refactor.rewrite');
CodeActionKind.Source = new CodeActionKind('source');
CodeActionKind.SourceOrganizeImports = new CodeActionKind('source.organizeImports');
CodeActionKind.SourceFixAll = new CodeActionKind('source.fixAll');

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
    this.isResolved = command !== undefined;
  }
}

class DocumentLink {
  constructor(range, target) {
    this.range = range;
    this.target = target;
  }
}

const SymbolKind = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
  Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
  Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
  Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
  Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
};

class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
    this.children = [];
  }
}

class SymbolInformation {
  constructor(name, kind, containerName, location) {
    this.name = name;
    this.kind = kind;
    if (typeof containerName === 'string') {
      this.containerName = containerName;
      this.location = location;
    } else {
      this.containerName = '';
      this.location = containerName;
    }
  }
}

class FoldingRange {
  constructor(start, end, kind) {
    this.start = start;
    this.end = end;
    this.kind = kind;
  }
}
const FoldingRangeKind = { Comment: 'comment', Imports: 'imports', Region: 'region' };

class ParameterInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
  }
}
class SignatureInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
    this.parameters = [];
    this.activeParameter = 0;
  }
}
class SignatureHelp {
  constructor() {
    this.signatures = [];
    this.activeSignature = 0;
    this.activeParameter = 0;
  }
}

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

// ---- the API for one extension ----------------------------------------------------------------------------------

function toPath(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (value.fsPath !== undefined) return value.fsPath;
  if (value.uri) return toPath(value.uri);
  return undefined;
}

function createApi(host, ext) {
  const { state, request, notify } = host;
  let handleCounter = 0;
  const granted = new Set(ext.permissions || []);
  const need = (permission) => {
    if (!granted.has(permission)) throw permissionError(permission);
  };
  // Everything this extension registered through the API, so deactivating (or a failed activation) can undo it.
  const tracked = new Set();
  const track = (disposable) => {
    tracked.add(disposable);
    return disposable;
  };
  // Listeners run as this extension, so what they log or do is attributed to it.
  const asExtension = (fn) => (host.als ? (...args) => host.als.run(ext.id, () => fn(...args)) : fn);
  const editors = createEditorApi({
    host,
    ext,
    need,
    namespace,
    asExtension,
    Disposable,
    types: { Position, Range, Selection, Uri },
  });
  const { document, editor } = editors;

  // -- commands
  const commands = namespace('commands', {
    registerCommand(command, callback) {
      need('commands');
      const existing = state.commands.get(command);
      if (existing) {
        throw new Error(
          existing.id === ext.id
            ? `Command '${command}' is already registered by this extension.`
            : `Command '${command}' is already registered by ${existing.id}; an extension can't replace another extension's command.`,
        );
      }
      state.commands.set(command, { id: ext.id, callback });
      notify('commands/registered', { command, extension: ext.id });
      return track(new Disposable(() => {
        if (state.commands.get(command) && state.commands.get(command).callback === callback) {
          state.commands.delete(command);
          notify('commands/unregistered', { command });
        }
      }));
    },
    /** Runs with the active text editor and an edit builder; the edits are one undoable change. */
    registerTextEditorCommand(command, callback) {
      return commands.registerCommand(command, async (...args) => {
        const active = editors.activeEditor();
        if (!active) {
          console.error(`Command '${command}' needs an active text editor.`);
          return undefined;
        }
        let result;
        await active.edit((builder) => {
          result = callback(active, builder, ...args);
        });
        return result;
      });
    },
    async executeCommand(command, ...args) {
      need('commands');
      const local = state.commands.get(command);
      if (local) return local.callback(...args);
      return request('commands/execute', { command, args });
    },
    async getCommands(filterInternal) {
      need('commands');
      return request('commands/getCommands', { filterInternal: !!filterInternal });
    },
  });

  // -- window
  function message(severity) {
    return (text, ...rest) => {
      const items = rest.filter((item) => typeof item === 'string' || (item && typeof item.title === 'string'));
      const labels = items.map((item) => (typeof item === 'string' ? item : item.title));
      if (labels.length === 0) {
        notify('ui/showMessage', { extension: ext.id, severity, message: String(text), items: [] });
        return Promise.resolve(undefined);
      }
      return request('ui/showMessage', { extension: ext.id, severity, message: String(text), items: labels }).then((label) => {
        const index = labels.indexOf(label);
        return index < 0 ? undefined : items[index];
      });
    };
  }

  function outputChannel(name, options) {
    let pendingLine = '';
    let closed = false;
    const write = (text) => {
      if (!closed) notify('log/output', { extension: ext.id, channel: name, text });
    };
    const channel = {
      name,
      append(value) {
        if (closed) return;
        pendingLine += String(value);
        const parts = pendingLine.split('\n');
        pendingLine = parts.pop();
        for (const part of parts) write(part.replace(/\r$/, ''));
      },
      appendLine(value) {
        if (closed) return;
        write(pendingLine + String(value));
        pendingLine = '';
      },
      replace(value) {
        notify('ui/clearOutput', { extension: ext.id, channel: name });
        channel.append(value);
      },
      clear() {
        notify('ui/clearOutput', { extension: ext.id, channel: name });
      },
      show() {
        notify('ui/showOutput', { extension: ext.id, channel: name });
      },
      hide() {},
      dispose() {
        closed = true;
        pendingLine = '';
      },
    };
    track(channel);
    if (options && options.log) {
      for (const level of ['trace', 'debug', 'info', 'warn', 'error']) {
        channel[level] = (text, ...args) => channel.appendLine(`[${level}] ${[text, ...args].join(' ')}`);
      }
    }
    return channel;
  }

  // -- workspace and languages (their own modules)
  const workspace = createWorkspaceApi({ host, ext, need, track, asExtension, Disposable, EventEmitter, Uri, editors, namespace, toPath });
  const languages = createLanguagesApi({
    host,
    ext,
    need,
    track,
    Disposable,
    namespace,
    editors,
    toPath,
    types: { Position, Range, SnippetString, CancellationTokenSource, Uri },
  });
  const { tasks } = tasksModule.createTaskApi({ host, ext, need, track, Disposable, EventEmitter, namespace, asExtension });

  const trees = createTreeApi({
    host,
    ext,
    track,
    executeCommand: (command, ...args) => commands.executeCommand(command, ...args),
    Disposable,
    EventEmitter,
  });
  const statusBar = createStatusBarApi({ host, ext, track, Disposable });
  const webviews = createWebviewApi({ host, ext, need, track, Disposable, EventEmitter, Uri, namespace, asExtension });
  const terminals = createTerminalApi({ host, ext, need, track, Disposable, EventEmitter, namespace, asExtension });
  const window = namespace('window', {
    registerTreeDataProvider: trees.registerTreeDataProvider,
    createTreeView: trees.createTreeView,
    showInformationMessage: message('info'),
    showWarningMessage: message('warning'),
    showErrorMessage: message('error'),
    createOutputChannel: outputChannel,
    createTerminal: terminals.createTerminal,
    get terminals() {
      return terminals.terminals;
    },
    get activeTerminal() {
      return undefined;
    },
    onDidOpenTerminal: terminals.onDidOpenTerminal,
    onDidCloseTerminal: terminals.onDidCloseTerminal,
    registerWebviewViewProvider: webviews.registerWebviewViewProvider,
    /** Opens a document in an editor tab: a file (`workspaceRead`) or a custom-scheme document (read-only). */
    async showTextDocument(target, options) {
      const doc = target && target.getText ? target : await workspace.openTextDocument(target);
      const uri = doc.uri;
      if (uri.scheme === 'file') {
        await request('ui/showTextDocument', { extension: ext.id, path: uri.fsPath, preserveFocus: !!(options && options.preserveFocus) });
        return editors.activeEditor();
      }
      const data = state.documents.get(uri.toString());
      await request('ui/showVirtualDocument', {
        extension: ext.id,
        uri: uri.toString(),
        scheme: uri.scheme,
        path: uri.path,
        text: doc.getText(),
        languageId: doc.languageId,
        readonly: !data || data.readonly !== false,
      });
      return undefined;
    },
    async showQuickPick(items, options = {}) {
      const list = await Promise.resolve(items);
      const normalized = list.map((item) =>
        typeof item === 'string' ? { label: item } : { label: item.label, description: item.description, detail: item.detail },
      );
      const picked = await request('ui/showQuickPick', {
        extension: ext.id,
        items: normalized,
        placeHolder: options.placeHolder,
        canPickMany: !!options.canPickMany,
      });
      if (picked === null || picked === undefined) return undefined;
      return options.canPickMany ? picked.map((index) => list[index]) : list[picked];
    },
    async showInputBox(options = {}) {
      const value = await request('ui/showInputBox', {
        extension: ext.id,
        prompt: options.prompt,
        placeHolder: options.placeHolder,
        value: options.value,
        password: !!options.password,
        title: options.title,
      });
      return value === null ? undefined : value;
    },
    get activeTextEditor() {
      return editors.activeEditor();
    },
    get visibleTextEditors() {
      const active = editors.activeEditor();
      return active ? [active] : [];
    },
    onDidChangeActiveTextEditor: (listener, thisArg, disposables) =>
      track(host.events.on('activeEditor')(asExtension((data) => listener(editor(data.editor))), thisArg, disposables)),
    onDidChangeTextEditorSelection: (listener, thisArg, disposables) =>
      track(editors.selectionEvent(listener, thisArg, disposables)),
    createStatusBarItem: statusBar.createStatusBarItem,
    createWebviewPanel: webviews.createWebviewPanel,
  });

  const extensionObject = (found) => {
    if (!found) return undefined;
    const extension = {
      id: found.id,
      extensionPath: found.path,
      extensionUri: Uri.file(found.path),
      packageJSON: found.manifest,
      get isActive() { const run = state.running.get(found.id); return !!run && !run.activating; },
      get exports() { return state.running.get(found.id)?.exports; },
      async activate() {
        if (!state.extensions.has(found.id)) throw new Error(`Extension '${found.id}' was uninstalled.`);
        return host.activateExtension(found.id);
      },
    };
    return extension;
  };
  const extensions = namespace('extensions', {
    onDidChange: (listener, thisArg, disposables) =>
      track(host.events.on('extensions')(asExtension(listener), thisArg, disposables)),
    getExtension(id) {
      const normalized = String(id).toLowerCase();
      const found = state.extensions.get(normalized) ||
        [...state.extensions.values()].find((item) => item.id.toLowerCase() === normalized);
      return extensionObject(found);
    },
    get all() {
      return [...state.extensions.values()].map(extensionObject);
    },
  });

  const env = namespace('env', {
    appName: 'OpenMind Studio',
    appHost: 'desktop',
    language: 'en',
    uriScheme: 'openmind',
    machineId: 'openmind-studio',
    sessionId: String(process.pid),
    shell: process.env.ComSpec || process.env.SHELL || '',
    openExternal: async (uri) => {
      need('network');
      return request('ui/openExternal', { url: String(uri && uri.toString ? uri.toString() : uri) });
    },
  });

  // vscode.l10n: messages are shown as written (English), with {0} / {name} arguments filled in.
  const l10n = namespace('l10n', {
    t(message, ...args) {
      let text = message;
      let values = args;
      if (message && typeof message === 'object') {
        text = message.message;
        values = message.args === undefined ? [] : [message.args];
      }
      const named = values.length === 1 && values[0] && typeof values[0] === 'object' && !Array.isArray(values[0]) ? values[0] : null;
      const list = Array.isArray(values[0]) && values.length === 1 ? values[0] : values;
      return String(text).replace(/\{([^}]+)\}/g, (whole, key) => {
        const value = named ? named[key] : list[Number(key)];
        return value === undefined ? whole : String(value);
      });
    },
    bundle: undefined,
    uri: undefined,
  });

  const api = {
    version: '1.85.0',
    l10n,
    commands,
    window,
    workspace,
    languages,
    extensions,
    env,
    Disposable,
    EventEmitter,
    Uri,
    Position,
    Range,
    Selection,
    Location,
    Diagnostic,
    DiagnosticSeverity,
    MarkdownString,
    Hover,
    CompletionItem,
    CompletionItemKind,
    CompletionList,
    CodeAction,
    CodeActionKind,
    CodeLens,
    DocumentLink,
    SymbolKind,
    DocumentSymbol,
    SymbolInformation,
    FoldingRange,
    FoldingRangeKind,
    ParameterInformation,
    SignatureInformation,
    SignatureHelp,
    SnippetString,
    CancellationTokenSource,
    ConfigurationTarget,
    ViewColumn,
    EndOfLine,
    TextEditorRevealType,
    TextEditorSelectionChangeKind,
    StatusBarAlignment,
    ThemeColor,
    WorkspaceEdit: editors.WorkspaceEdit,
    TextEdit,
    RelativePattern,
    FileType,
    FileSystemError,
    Task: tasksModule.Task,
    ShellExecution: tasksModule.ShellExecution,
    ProcessExecution: tasksModule.ProcessExecution,
    CustomExecution: tasksModule.CustomExecution,
    TaskGroup: tasksModule.TaskGroup,
    TaskScope: tasksModule.TaskScope,
    TaskRevealKind: tasksModule.TaskRevealKind,
    TaskPanelKind: tasksModule.TaskPanelKind,
    tasks,
    TreeItem,
    TreeItemCollapsibleState,
    ThemeIcon,
  };
  const result = namespace('', api);
  cleanups.set(result, () => {
    for (const disposable of [...tracked].reverse()) {
      try {
        if (disposable && typeof disposable.dispose === 'function') disposable.dispose();
      } catch (error) {
        console.error(`dispose failed: ${error}`);
      }
    }
    tracked.clear();
  });
  return result;
}

const cleanups = new WeakMap();

/** Undoes everything an extension registered through its `vscode` API (listeners, providers, channels...). */
function disposeApi(api) {
  const cleanup = cleanups.get(api);
  if (cleanup) cleanup();
}

module.exports = { createApi, createEventHub, disposeApi, setUnsupportedReporter, Uri, Disposable, EventEmitter, unsupported };
