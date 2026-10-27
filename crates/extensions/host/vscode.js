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
const testingModule = require('./testing.js');
const scmModule = require('./scm.js');
const notebookModule = require('./notebooks.js');
const debugModule = require('./debug.js');

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

const { Disposable, EventEmitter, createEventHub, Uri, Position, Range, Selection, Location, DiagnosticSeverity, Diagnostic, DiagnosticTag, DiagnosticRelatedInformation, CompletionTriggerKind, CodeActionTriggerKind, SymbolTag, MarkdownString, Hover, CompletionItemKind, CompletionItem, CompletionList, SnippetString, CancellationTokenSource, CancellationError, CancellationToken } = require('./types.js');
const { publicEnums, ColorThemeKind, UIKind, QuickInputButtons, CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, TypeHierarchyItem, InlineCompletionItem, InlineCompletionList, InlineCompletionTriggerKind, Color, ColorInformation, ColorPresentation, InlayHintLabelPart, InlayHint, InlayHintKind, SemanticTokensLegend, SemanticTokens, SemanticTokensEdit, SemanticTokensEdits, SemanticTokensBuilder, CodeActionKind, CodeAction, CodeLens, DocumentLink, SymbolKind, DocumentSymbol, SymbolInformation, FoldingRange, FoldingRangeKind, DocumentHighlightKind, DocumentHighlight, SelectionRange, LinkedEditingRanges, ParameterInformation, SignatureInformation, SignatureHelp, ConfigurationTarget, ViewColumn } = require('./languagetypes.js');

// ---- the API for one extension ----------------------------------------------------------------------------------

function toPath(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  // A custom-scheme document (virtual, untitled) is keyed by its Uri text, a file by its native path (as showEditor).
  if (value instanceof Uri && value.scheme !== 'file') return value.toString();
  if (value.fsPath !== undefined) return value.fsPath;
  if (value.uri) return toPath(value.uri);
  return undefined;
}

function createApi(host, ext) {
  const { state, request, notify } = host;
  let handleCounter = 0;
  const granted = new Set(ext.permissions || []);
  const need = (permission) => {
    if (!granted.has(permission)) throw permissionError(permission, ext.id);
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
    track,
  });
  const { document, editor } = editors;

  // -- commands
  const commands = namespace('commands', {
    registerCommand(command, callback, thisArg) {
      need('commands');
      if (typeof command !== 'string' || !command || typeof callback !== 'function') {
        throw new TypeError('A command needs a non-empty identifier and a callback.');
      }
      const invoke = (...args) => callback.apply(thisArg, args);
      const existing = state.commands.get(command);
      if (existing) {
        throw new Error(
          existing.id === ext.id
            ? `Command '${command}' is already registered by this extension.`
            : `Command '${command}' is already registered by ${existing.id}; an extension can't replace another extension's command.`,
        );
      }
      state.commands.set(command, { id: ext.id, callback: invoke });
      notify('commands/registered', { command, extension: ext.id });
      return track(new Disposable(() => {
        if (state.commands.get(command) && state.commands.get(command).callback === invoke) {
          state.commands.delete(command);
          notify('commands/unregistered', { command });
        }
      }));
    },
    /** Runs with the active text editor and an edit builder; the edits are one undoable change. */
    registerTextEditorCommand(command, callback, thisArg) {
      return commands.registerCommand(command, async (...args) => {
        const active = editors.activeEditor();
        if (!active) {
          console.error(`Command '${command}' needs an active text editor.`);
          return undefined;
        }
        let result;
        await active.edit((builder) => {
          result = callback.call(thisArg, active, builder, ...args);
        });
        return result;
      });
    },
    async executeCommand(command, ...args) {
      need('commands');
      const local = state.commands.get(command);
      if (local) return host.als
        ? host.als.run(local.id, () => local.callback(...args))
        : local.callback(...args);
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
  const workbenchParts = { host, ext, need, track, Disposable, EventEmitter, CancellationTokenSource, Uri, workspace, editors };
  const notebookApi = notebookModule.create(workbenchParts);
  Object.defineProperties(workspace, Object.getOwnPropertyDescriptors(notebookApi.workspace));
  const tests = namespace('tests', testingModule.create(workbenchParts));
  const scm = namespace('scm', scmModule.create(workbenchParts));
  const debug = namespace('debug', debugModule.create(workbenchParts));
  const languages = createLanguagesApi({
    asExtension,
    host,
    ext,
    need,
    track,
    Disposable,
    namespace,
    editors,
    toPath,
    types: { Position, Range, SnippetString, CancellationTokenSource, Uri, CodeActionKind, Diagnostic, Color },
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
  const colorTheme = () => Object.freeze({ kind: state.colorTheme === 'light' ? ColorThemeKind.Light
    : state.colorTheme === 'high-contrast' ? ColorThemeKind.HighContrast : state.colorTheme === 'high-contrast-light' ? ColorThemeKind.HighContrastLight : ColorThemeKind.Dark });
  function setStatusBarMessage(text, timeoutOrThenable) {
    const messages = state.statusMessages ||= [];
    const item = statusBar.createStatusBarItem(); item.text = String(text);
    let disposed = false; let timer;
    const entry = { item }; messages.at(-1)?.item.hide(); messages.push(entry); item.show();
    const disposable = track(new Disposable(() => {
      if (disposed) return;
      disposed = true; clearTimeout(timer);
      const index = messages.indexOf(entry); const last = index === messages.length - 1;
      if (index >= 0) messages.splice(index, 1);
      item.dispose(); if (last) messages.at(-1)?.item.show();
    }));
    if (typeof timeoutOrThenable === 'number') timer = setTimeout(() => disposable.dispose(), Math.max(0, timeoutOrThenable));
    else if (timeoutOrThenable) Promise.resolve(timeoutOrThenable).then(() => disposable.dispose(), () => disposable.dispose());
    return disposable;
  }
  function createQuickInput(kind) {
    const id = `${ext.id}#quick-${require('crypto').randomUUID()}`;
    const inputs = state.quickInputs ||= new Map();
    const emitters = new Map();
    const objectIds = new WeakMap(); const objects = new Map(); let serial = 0;
    let visible = false, disposed = false, scheduled = false;
    const fields = { title: undefined, step: undefined, totalSteps: undefined, enabled: true, busy: false,
      ignoreFocusOut: false, value: '', valueSelection: undefined, placeholder: undefined, buttons: [], prompt: undefined,
      password: false, validationMessage: undefined, items: [], activeItems: [], selectedItems: [], canSelectMany: false,
      matchOnDescription: false, matchOnDetail: false, keepScrollPosition: false };
    const remember = value => {
      if (!value || typeof value !== 'object') throw new TypeError('Quick input items and buttons must be objects.');
      if (!objectIds.has(value)) objectIds.set(value, String(++serial));
      const key = objectIds.get(value); objects.set(key, value); return key;
    };
    const emit = (name, value) => emitters.get(name)?.fire(value);
    const button = value => ({ id: remember(value), tooltip: value.tooltip, back: value === QuickInputButtons.Back });
    const snapshot = () => {
      objects.clear();
      const items = fields.items.map(item => ({ id: remember(item), label: String(item.label || ''), description: item.description, detail: item.detail,
        kind: item.kind, picked: item.picked, alwaysShow: item.alwaysShow, buttons: (item.buttons || []).map(button) }));
      return { extension: ext.id, id, kind, visible, ...Object.fromEntries(Object.entries(fields).filter(([key]) => !['items', 'buttons', 'activeItems', 'selectedItems'].includes(key))),
        items, buttons: fields.buttons.map(button), activeItems: fields.activeItems.filter(value => fields.items.includes(value)).map(remember),
        selectedItems: fields.selectedItems.filter(value => fields.items.includes(value)).map(remember) };
    };
    const push = () => {
      if (disposed || scheduled || !visible) return;
      scheduled = true; queueMicrotask(() => { scheduled = false; if (!disposed && visible) notify('quickInput/set', snapshot()); });
    };
    const api = {};
    for (const key of Object.keys(fields)) Object.defineProperty(api, key, { enumerable: true, get: () => fields[key], set(value) {
      if (disposed) return;
      if (['items', 'buttons', 'activeItems', 'selectedItems'].includes(key) && !Array.isArray(value)) throw new TypeError(`${key} must be an array.`);
      if (key === 'items' && value.some(item => !item || typeof item !== 'object' || typeof item.label !== 'string')) throw new TypeError('Quick pick items need string labels.');
      const previous = fields[key]; fields[key] = key === 'value' ? String(value ?? '') : value;
      if (key === 'items') { fields.selectedItems = fields.selectedItems.filter(item => value.includes(item)); fields.activeItems = fields.activeItems.filter(item => value.includes(item)); }
      push();
      if (key === 'value' && previous !== fields.value) emit('changeValue', fields.value);
      if (key === 'activeItems') emit('changeActive', fields.activeItems);
      if (key === 'selectedItems') emit('changeSelection', fields.selectedItems);
    } });
    for (const [name, eventName] of Object.entries({ onDidAccept: 'accept', onDidHide: 'hide', onDidChangeValue: 'changeValue',
      onDidChangeActive: 'changeActive', onDidChangeSelection: 'changeSelection', onDidTriggerButton: 'button', onDidTriggerItemButton: 'itemButton' })) {
      const emitter = new EventEmitter(); emitters.set(eventName, emitter);
      api[name] = (listener, thisArg, disposables) => track(emitter.event(asExtension(value => listener.call(thisArg, value)), undefined, disposables));
    }
    api.show = () => { if (!disposed) { visible = true; push(); } };
    api.hide = () => { if (visible) { visible = false; notify('quickInput/set', { extension: ext.id, id, visible: false }); emit('hide'); } };
    api.dispose = () => { if (disposed) return; api.hide(); disposed = true; inputs.delete(id); objects.clear(); for (const emitter of emitters.values()) emitter.dispose(); };
    inputs.set(id, { extension: ext.id, event: params => {
      if (!visible || disposed) return;
      if (params.event === 'hide') { api.hide(); return; }
      if (!fields.enabled) return;
      if (params.event === 'value') api.value = params.value;
      else if (params.event === 'active' || params.event === 'selection') {
        const selected = (Array.isArray(params.items) ? params.items : []).map(key => objects.get(key)).filter(value => value && fields.items.includes(value));
        api[params.event === 'active' ? 'activeItems' : 'selectedItems'] = fields.canSelectMany || params.event === 'active' ? selected : selected.slice(0, 1);
      } else if (params.event === 'accept') { const invalid = fields.validationMessage; if (kind !== 'input' || !(typeof invalid === 'string' ? invalid.length > 0 : invalid?.severity === 3)) emit('accept'); }
      else if (params.event === 'button') { const value = objects.get(params.button); if (fields.buttons.includes(value)) emit('button', value); }
      else if (params.event === 'itemButton') {
        const item = objects.get(params.item), value = objects.get(params.button);
        if (fields.items.includes(item) && item.buttons?.includes(value)) emit('itemButton', { item, button: value });
      }
    } });
    return track(api);
  }
  function withProgress(options, task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('Progress requires a task callback.'));
    const source = new CancellationTokenSource();
    const item = statusBar.createStatusBarItem();
    const command = `openmind.progress.cancel.${ext.id}.${Date.now()}.${Math.random()}`;
    let percentage = 0, message = '', done = false;
    const render = () => { item.text = `${options?.title || ext.id}${message ? ': ' + message : ''}${percentage ? ' ' + Math.round(percentage) + '%' : ''}`; };
    const callback = asExtension(() => source.cancel());
    if (options?.cancellable) {
      state.commands.set(command, { id: ext.id, callback }); notify('commands/registered', { command, extension: ext.id });
      item.command = command; item.tooltip = 'Cancel';
    }
    const cleanup = track(new Disposable(() => {
      if (done) return; done = true; source.cancel(); source.dispose(); item.dispose();
      if (state.commands.get(command)?.callback === callback) { state.commands.delete(command); notify('commands/unregistered', { command }); }
    }));
    render(); item.show();
    const progress = { report(value) {
      if (done) return;
      if (value?.message !== undefined) message = String(value.message);
      if (Number.isFinite(value?.increment)) percentage = Math.max(0, Math.min(100, percentage + value.increment));
      render();
    } };
    return Promise.resolve().then(asExtension(() => task(progress, source.token))).finally(() => cleanup.dispose());
  }
  function fileDialogOptions(options = {}) {
    if (options.defaultUri && options.defaultUri.scheme !== 'file') throw new Error('Native dialogs currently require a file URI.');
    return { title: options.title, defaultPath: options.defaultUri?.fsPath, canSelectFiles: options.canSelectFiles,
      canSelectFolders: options.canSelectFolders, canSelectMany: options.canSelectMany,
      filters: options.filters && Object.entries(options.filters).map(([name, extensions]) => ({ name, extensions })) };
  }
  const window = namespace('window', {
    get state() { return state.windowState || Object.freeze({ focused: false }); },
    onDidChangeWindowState: (listener, thisArg, disposables) => track(host.events.on('windowState')(asExtension(value => listener.call(thisArg, value)), undefined, disposables)),
    createTextEditorDecorationType: editors.createTextEditorDecorationType,
    setStatusBarMessage,
    get activeColorTheme() { return colorTheme(); },
    onDidChangeActiveColorTheme: (listener, thisArg, disposables) => track(host.events.on('colorTheme')(asExtension(() => listener.call(thisArg, colorTheme())), undefined, disposables)),
    async showOpenDialog(options) {
      const selected = await request('ui/showOpenDialog', { extension: ext.id, options: fileDialogOptions(options) });
      return selected == null ? undefined : selected.map(file => Uri.file(file));
    },
    async showSaveDialog(options) {
      const selected = await request('ui/showSaveDialog', { extension: ext.id, options: fileDialogOptions(options) });
      return selected == null ? undefined : Uri.file(selected);
    },
    createQuickPick: () => createQuickInput('quickPick'),
    async showWorkspaceFolderPick(options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Workspace folder pick options must be an object.');
      if (options.placeHolder !== undefined && typeof options.placeHolder !== 'string') throw new TypeError('Workspace folder placeholder must be a string.');
      if (options.ignoreFocusOut !== undefined && typeof options.ignoreFocusOut !== 'boolean') throw new TypeError('Workspace folder ignoreFocusOut must be boolean.');
      const folders = workspace.workspaceFolders || [];
      if (!folders.length) return undefined;
      const pick = createQuickInput('quickPick');
      pick.placeholder = options.placeHolder;
      pick.ignoreFocusOut = options.ignoreFocusOut === true;
      pick.matchOnDescription = true;
      pick.items = folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder }));
      return new Promise(resolve => {
        let done = false, completion;
        const finish = value => {
          if (done) return;
          done = true;
          accepted.dispose(); hidden.dispose(); changed.dispose(); pick.dispose();
          for (const disposable of [accepted, hidden, pick, completion]) tracked.delete(disposable);
          resolve(value);
        };
        const accepted = pick.onDidAccept(() => {
          const item = pick.selectedItems[0] || pick.activeItems[0];
          if (!item) return;
          finish(item.folder);
        });
        const hidden = pick.onDidHide(() => finish(undefined));
        const changed = host.events.on('workspaceFolders')(() => finish(undefined));
        completion = track(new Disposable(() => finish(undefined)));
        pick.show();
      });
    },
    createInputBox: () => createQuickInput('input'),
    withProgress,
    withScmProgress: task => withProgress({ location: publicEnums.ProgressLocation.SourceControl }, task),
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
    get activeTerminal() { return terminals.activeTerminal; },
    onDidChangeActiveTerminal: terminals.onDidChangeActiveTerminal,
    onDidChangeTerminalState: terminals.onDidChangeTerminalState,
    onDidOpenTerminal: terminals.onDidOpenTerminal,
    onDidCloseTerminal: terminals.onDidCloseTerminal,
    registerWebviewViewProvider: webviews.registerWebviewViewProvider,
    /** Opens a document in an editor tab: a file (`workspaceRead`) or a custom-scheme document (read-only). */
    async showTextDocument(target, options, preserveFocus) {
      if (typeof options === 'number' || options === undefined) options = { viewColumn: options, preserveFocus };
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Invalid document show options.');
      for (const key of Object.keys(options)) if (!['viewColumn','preserveFocus','preview','selection'].includes(key)) throw unsupportedError(`TextDocumentShowOptions.${key}`);
      const column = options.viewColumn;
      if (column !== undefined && (!Number.isInteger(column) || ![-1,-2,1,2,3,4,5,6,7,8,9].includes(column))) throw new TypeError('Invalid editor view column.');
      for (const key of ['preserveFocus','preview']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new TypeError('Editor show flags must be boolean.');
      let selection;
      if (options.selection !== undefined) {
        const range = options.selection;
        if (![range?.start?.line,range?.start?.character,range?.end?.line,range?.end?.character].every(n => Number.isInteger(n) && n >= 0)) throw new TypeError('Invalid editor selection.');
        selection = { startLine: range.start.line, startColumn: range.start.character, endLine: range.end.line, endColumn: range.end.character };
      }
      const showOptions = { viewColumn: column, preserveFocus: !!options.preserveFocus, preview: options.preview, selection };
      const doc = target && target.getText ? target : await workspace.openTextDocument(target);
      const uri = doc.uri;
      if (uri.scheme !== 'file' && uri.scheme !== 'untitled') {
        const data = state.documents.get(uri.toString());
        if (!data) throw new Error('The virtual document is closed or unknown.');
        if (!data.native) {
          const opened = await request('workspace/openVirtualTextDocument', { extension: ext.id, uri: uri.toString(), text: data.text, languageId: data.languageId, readonly: data.readonly !== false, version: data.version });
          if (!opened?.native || opened.path !== uri.toString()) throw new Error('The native virtual document could not be opened.');
          state.documents.set(data.path, { ...data, ...opened });
        }
      }
      return editors.showEditor(uri.scheme === 'file' ? uri.fsPath : uri.toString(), showOptions);
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
      return editors.visibleEditors();
    },
    onDidChangeActiveTextEditor: (listener, thisArg, disposables) =>
      track(host.events.on('activeEditor')(asExtension((data) => listener.call(thisArg, editor(data.editor))), thisArg, disposables)),
    onDidChangeVisibleTextEditors: (listener, thisArg, disposables) =>
      track(host.events.on('visibleEditors')(asExtension(() => listener.call(thisArg, editors.visibleEditors())), undefined, disposables)),
    onDidChangeTextEditorViewColumn: (listener, thisArg, disposables) =>
      track(host.events.on('editorViewColumnChanged')(asExtension(data => listener.call(thisArg, { textEditor: editor(data), viewColumn: data.viewColumn })), undefined, disposables)),
    onDidChangeTextEditorVisibleRanges: (listener, thisArg, disposables) =>
      track(host.events.on('editorVisibleRangesChanged')(asExtension(data => { const target = editor(data); listener.call(thisArg, { textEditor: target, visibleRanges: target.visibleRanges }); }), undefined, disposables)),
    onDidChangeTextEditorOptions: (listener, thisArg, disposables) =>
      track(host.events.on('editorOptionsChanged')(asExtension(data => listener.call(thisArg, { textEditor: editor(data), options: require('./editorstate.js').resolvedOptions(data) })), thisArg, disposables)),
    onDidChangeTextEditorSelection: (listener, thisArg, disposables) =>
      track(editors.selectionEvent(listener, thisArg, disposables)),
    createStatusBarItem: statusBar.createStatusBarItem,
    createWebviewPanel: webviews.createWebviewPanel,
  });

  Object.defineProperties(window, Object.getOwnPropertyDescriptors(notebookApi.window));

  const extensionObject = (found) => {
    if (!found) return undefined;
    const extension = {
      id: found.id,
      extensionPath: found.path,
      extensionUri: Uri.file(found.path),
      packageJSON: found.packageJSON || found.manifest,
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
    clipboard: {
      readText: async () => String(await request('clipboard/readText', { extension: ext.id }) || ''),
      writeText: async value => { if (typeof value !== 'string') throw new TypeError('Clipboard text must be a string.'); await request('clipboard/writeText', { extension: ext.id, text: value }); },
    },
    asExternalUri: async uri => { if (!(uri instanceof Uri)) throw new TypeError('Expected a URI.'); return uri; },
    appName: 'OpenMind Studio',
    appHost: 'desktop',
    uiKind: UIKind.Desktop,
    remoteName: undefined,
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
    tests,
    scm,
    debug,
    notebooks: namespace('notebooks', notebookApi.notebooks),
    TestRunRequest: testingModule.TestRunRequest,
    TestRunProfileKind: testingModule.TestRunProfileKind,
    TestMessage: testingModule.TestMessage,
    TestTag: testingModule.TestTag,
    NotebookRange: notebookModule.NotebookRange,
    NotebookEdit: notebookModule.NotebookEdit,
    NotebookCellKind: notebookModule.NotebookCellKind,
    NotebookCellData: notebookModule.NotebookCellData,
    NotebookData: notebookModule.NotebookData,
    NotebookCellOutput: notebookModule.NotebookCellOutput,
    NotebookCellOutputItem: notebookModule.NotebookCellOutputItem,
    DebugAdapterExecutable: debugModule.DebugAdapterExecutable,
    DebugAdapterServer: debugModule.DebugAdapterServer,
    DebugAdapterInlineImplementation: debugModule.DebugAdapterInlineImplementation,
    SourceBreakpoint: debugModule.SourceBreakpoint,
    FunctionBreakpoint: debugModule.FunctionBreakpoint,
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
    DiagnosticTag,
    DiagnosticRelatedInformation,
    CompletionTriggerKind,
    CodeActionTriggerKind,
    SymbolTag,
    MarkdownString,
    Hover,
    CompletionItem,
    CompletionItemKind,
    CompletionList,
    CodeAction,
    CodeActionKind,
    SemanticTokens, SemanticTokensBuilder, SemanticTokensEdit, SemanticTokensEdits, SemanticTokensLegend,
    Color, ColorInformation, ColorPresentation, InlayHint, InlayHintLabelPart, InlayHintKind,
    QuickInputButtons,
    CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, TypeHierarchyItem,
    InlineCompletionItem, InlineCompletionList, InlineCompletionTriggerKind,
    ColorThemeKind, UIKind,
    CodeLens,
    DocumentLink,
    SymbolKind,
    DocumentSymbol,
    SymbolInformation,
    FoldingRange,
    FoldingRangeKind,
    DocumentHighlight,
    DocumentHighlightKind,
    SelectionRange,
    LinkedEditingRanges,
    ParameterInformation,
    SignatureInformation,
    SignatureHelp,
    SnippetString,
    CancellationTokenSource,
    CancellationToken,
    CancellationError,
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
  Object.assign(api, publicEnums);
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

module.exports = { createApi, createEventHub, disposeApi, setUnsupportedReporter, Uri, Disposable, EventEmitter, CancellationTokenSource, CancellationToken, unsupported };

