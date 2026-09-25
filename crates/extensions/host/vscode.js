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

// Called with the message whenever an unsupported API is used (the host logs it, attributed to the extension).
let unsupportedReporter = null;
function setUnsupportedReporter(fn) {
  unsupportedReporter = fn;
}

const IGNORED = new Set(['__esModule', 'then', 'toJSON', 'inspect', 'constructor', 'prototype', 'valueOf', 'toString']);

function unsupported(name) {
  const message = `VS Code API '${name}' is not supported by OpenMind Studio yet.`;
  return new Proxy(function unsupportedApi() {}, {
    get(_target, prop) {
      if (typeof prop === 'symbol' || IGNORED.has(prop)) return undefined;
      return unsupported(name ? `${name}.${prop}` : String(prop));
    },
    apply() {
      if (unsupportedReporter) unsupportedReporter(message);
      throw new Error(message);
    },
    construct() {
      if (unsupportedReporter) unsupportedReporter(message);
      throw new Error(message);
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
    return new Uri(match[1], match[2], decodeURIComponent(match[3]), match[4], match[5]);
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
  constructor(value = '') {
    this.value = value;
  }
  appendText(text) {
    this.value += text;
    return this;
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
  appendCodeblock(code, language = '') {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
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
  constructor(value = '') {
    this.value = value;
  }
}

class CancellationTokenSource {
  constructor() {
    const emitter = new EventEmitter();
    this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
    this._emitter = emitter;
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this._emitter.fire();
  }
  dispose() {
    this._emitter.dispose();
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

  const event = (name) => (listener, thisArg, disposables) =>
    track(host.events.on(name)(asExtension(listener), thisArg, disposables));
  const documentEvent = (name) => (listener, thisArg, disposables) => {
    need('workspaceRead');
    return track(
      host.events.on(name)(
        asExtension((data) =>
          listener(
            name === 'documentChanged'
              ? { document: document(state.documents.get(data.path) || data), contentChanges: [] }
              : document(state.documents.get(data.path) || data),
          ),
        ),
        thisArg,
        disposables,
      ),
    );
  };

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
  const window = namespace('window', {
    registerTreeDataProvider: trees.registerTreeDataProvider,
    createTreeView: trees.createTreeView,
    showInformationMessage: message('info'),
    showWarningMessage: message('warning'),
    showErrorMessage: message('error'),
    createOutputChannel: outputChannel,
    createTerminal() {
      need('terminal');
      throw new Error("VS Code API 'window.createTerminal' is not supported by OpenMind Studio yet.");
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

  // -- workspace
  function configuration(section) {
    const prefix = section ? `${section}.` : '';
    const lookup = (key) => {
      const full = prefix + key;
      if (full in state.configuration) return state.configuration[full];
      const nested = {};
      let found = false;
      for (const name of Object.keys(state.configuration)) {
        if (name.startsWith(`${full}.`)) {
          nested[name.slice(full.length + 1)] = state.configuration[name];
          found = true;
        }
      }
      return found ? nested : undefined;
    };
    return {
      get(key, fallback) {
        const value = lookup(key);
        return value === undefined ? fallback : value;
      },
      has: (key) => lookup(key) !== undefined,
      inspect: (key) => ({ key: prefix + key, globalValue: lookup(key) }),
      async update(key, value, target) {
        await request('workspace/updateConfiguration', { key: prefix + key, value: value === undefined ? null : value, target: target === ConfigurationTarget.Workspace || target === false ? 'workspace' : 'user' });
      },
    };
  }

  const workspace = namespace('workspace', {
    get workspaceFolders() {
      const folders = state.workspaceFolders;
      if (!folders.length) return undefined;
      return folders.map((folder, index) => ({ uri: Uri.file(folder.path), name: folder.name, index }));
    },
    get name() {
      return state.workspaceFolders[0] ? state.workspaceFolders[0].name : undefined;
    },
    get rootPath() {
      return state.workspaceFolders[0] ? state.workspaceFolders[0].path : undefined;
    },
    getWorkspaceFolder(uri) {
      const target = toPath(uri);
      const folder = state.workspaceFolders.find((item) => target && (target === item.path || target.startsWith(item.path + path.sep)));
      return folder ? { uri: Uri.file(folder.path), name: folder.name, index: state.workspaceFolders.indexOf(folder) } : undefined;
    },
    asRelativePath(value) {
      const target = toPath(value);
      const folder = state.workspaceFolders.find((item) => target && target.startsWith(item.path + path.sep));
      return folder ? target.slice(folder.path.length + 1).replace(/\\/g, '/') : target;
    },
    getConfiguration(section) {
      need('settings');
      return configuration(section);
    },
    onDidChangeConfiguration: (listener, thisArg, disposables) => {
      need('settings');
      return track(host.events.on('configuration')(
        asExtension((data) =>
          listener({
            affectsConfiguration: (section) => data.changed.some((key) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`)),
          })),
        thisArg,
        disposables,
      ));
    },
    onDidChangeWorkspaceFolders: event('workspaceFolders'),
    get textDocuments() {
      need('workspaceRead');
      return [...state.documents.values()].map(document);
    },
    async openTextDocument(target) {
      const file = toPath(target);
      if (!file) throw new Error('openTextDocument needs a file path or a file Uri.');
      need(state.workspaceFolders.some((folder) => within(folder.path, file)) ? 'workspaceRead' : 'filesystemOutsideWorkspace');
      const known = state.documents.get(file);
      if (known) return document(known);
      const data = await request('workspace/openTextDocument', { path: file });
      state.documents.set(file, data);
      return document(data);
    },
    applyEdit: (edit) => editors.applyEdit(edit),
    onDidOpenTextDocument: documentEvent('documentOpened'),
    onDidCloseTextDocument: documentEvent('documentClosed'),
    onDidChangeTextDocument: documentEvent('documentChanged'),
    onDidSaveTextDocument: documentEvent('documentSaved'),
  });

  // -- languages
  function selectors(selector) {
    const list = Array.isArray(selector) ? selector : [selector];
    return list.map((item) => (typeof item === 'string' ? { language: item } : { language: item.language, scheme: item.scheme, pattern: typeof item.pattern === 'string' ? item.pattern : undefined }));
  }

  function register(kind, selector, invoke, extra) {
    handleCounter += 1;
    const handle = `${ext.id}:${kind}:${handleCounter}`;
    state.providers.set(handle, { kind, extension: ext.id, invoke });
    notify('languages/registered', { handle, kind, extension: ext.id, selector: selectors(selector), ...extra });
    return track(new Disposable(() => {
      if (state.providers.delete(handle)) notify('languages/unregistered', { handle });
    }));
  }

  const cancelled = new CancellationTokenSource().token;
  const text = (value) => (value === undefined || value === null ? undefined : typeof value === 'string' ? value : value.value !== undefined ? { value: value.value } : String(value));
  const rangeOut = (range) => range && { startLine: range.start.line, startColumn: range.start.character, endLine: range.end.line, endColumn: range.end.character };

  const languages = namespace('languages', {
    getLanguages: async () => request('workspace/getLanguages', {}),
    registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
      need('languages');
      return register(
        'completion',
        selector,
        async ({ path: file, position }) => {
          const result = await provider.provideCompletionItems(document(state.documents.get(file)), new Position(position.line, position.character), cancelled, { triggerKind: 0 });
          const items = Array.isArray(result) ? result : result ? result.items : [];
          return (items || []).map((item) => ({
            label: typeof item.label === 'string' ? item.label : item.label.label,
            kind: item.kind,
            detail: item.detail,
            documentation: text(item.documentation),
            insertText: item.insertText instanceof SnippetString ? { snippet: item.insertText.value } : item.insertText === undefined ? undefined : String(item.insertText),
            sortText: item.sortText,
            filterText: item.filterText,
          }));
        },
        { triggerCharacters },
      );
    },
    registerHoverProvider(selector, provider) {
      need('languages');
      return register('hover', selector, async ({ path: file, position }) => {
        const result = await provider.provideHover(document(state.documents.get(file)), new Position(position.line, position.character), cancelled);
        if (!result) return null;
        return { contents: result.contents.map(text).filter((entry) => entry !== undefined), range: rangeOut(result.range) };
      });
    },
    registerDefinitionProvider(selector, provider) {
      need('languages');
      return register('definition', selector, async ({ path: file, position }) => {
        const result = await provider.provideDefinition(document(state.documents.get(file)), new Position(position.line, position.character), cancelled);
        const list = Array.isArray(result) ? result : result ? [result] : [];
        return list.map((item) => ({ path: toPath(item.uri || item.targetUri), range: rangeOut(item.range || item.targetRange) }));
      });
    },
    createDiagnosticCollection(name = `collection-${(handleCounter += 1)}`) {
      need('languages');
      const collection = `${ext.id}:${name}`;
      const stored = new Map();
      const push = (file, list) =>
        notify('diagnostics/set', {
          collection,
          path: file,
          diagnostics: list.map((item) => ({ range: rangeOut(item.range), message: item.message, severity: item.severity, source: item.source, code: item.code === undefined ? undefined : String(item.code && item.code.value !== undefined ? item.code.value : item.code) })),
        });
      return track({
        name,
        set(target, diagnostics) {
          if (Array.isArray(target)) {
            for (const [uri, list] of target) this.set(uri, list);
            return;
          }
          const file = toPath(target);
          stored.set(file, diagnostics || []);
          push(file, diagnostics || []);
        },
        get: (uri) => stored.get(toPath(uri)),
        has: (uri) => stored.has(toPath(uri)),
        delete(uri) {
          const file = toPath(uri);
          stored.delete(file);
          push(file, []);
        },
        clear() {
          for (const file of stored.keys()) push(file, []);
          stored.clear();
        },
        forEach(callback) {
          for (const [file, list] of stored) callback(Uri.file(file), list, this);
        },
        dispose() {
          this.clear();
        },
      });
    },
  });

  const extensions = namespace('extensions', {
    getExtension(id) {
      const found = state.extensions.get(id) || [...state.extensions.values()].find((item) => item.id.toLowerCase() === String(id).toLowerCase());
      if (!found) return undefined;
      return { id: found.id, extensionPath: found.path, packageJSON: found.manifest, isActive: state.running.has(found.id), exports: undefined };
    },
    get all() {
      return [...state.extensions.values()].map((found) => ({ id: found.id, extensionPath: found.path, packageJSON: found.manifest, isActive: state.running.has(found.id) }));
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
