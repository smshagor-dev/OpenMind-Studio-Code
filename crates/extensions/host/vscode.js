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
    this._disposed = false;
    this.event = (listener, thisArg, disposables) => {
      if (typeof listener !== 'function') throw new TypeError('Event listener must be a function');
      if (this._disposed) return new Disposable(() => {});
      const subscription = { listener, thisArg, active: true };
      this._listeners.add(subscription);
      const disposable = new Disposable(() => {
        subscription.active = false;
        this._listeners.delete(subscription);
      });
      if (Array.isArray(disposables)) disposables.push(disposable);
      return disposable;
    };
  }
  fire(data) {
    if (this._disposed) return;
    for (const subscription of [...this._listeners]) {
      if (!subscription.active) continue;
      try {
        subscription.listener.call(subscription.thisArg, data);
      } catch (error) {
        console.error(`Error in an event listener: ${error && error.stack ? error.stack : error}`);
      }
    }
  }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const subscription of this._listeners) subscription.active = false;
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
    if (normalized.startsWith('//')) {
      const parts = normalized.slice(2).split('/');
      const authority = parts.shift();
      if (authority) return new Uri('file', authority, '/' + parts.join('/'), '', '');
    }
    return new Uri('file', '', normalized, '', '');
  }
  static parse(value, strict = false) {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(String(value));
    if (!match) {
      if (strict) throw new Error('Invalid URI: ' + String(value));
      return Uri.file(value);
    }
    const decode = (value) => decodeURIComponent(value || '');
    return new Uri(match[1], decode(match[2]), decode(match[3]), decode(match[4]), decode(match[5]));
  }
  static from(components) {
    if (!components || typeof components !== 'object' || !components.scheme) {
      throw new TypeError('Uri.from requires a scheme.');
    }
    return new Uri(
      String(components.scheme),
      String(components.authority || ''),
      String(components.path || ''),
      String(components.query || ''),
      String(components.fragment || ''),
    );
  }
  static joinPath(base, ...segments) {
    return base.with({ path: path.posix.join(base.path, ...segments) });
  }
  get fsPath() {
    let value = this.path;
    if (/^\/[a-zA-Z]:/.test(value)) value = value.slice(1);
    if (this.scheme === 'file' && this.authority) {
      value = '//' + this.authority + (this.path.startsWith('/') ? this.path : '/' + this.path);
    }
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
  toString(skipEncoding = false) {
    if (skipEncoding) {
      return `${this.scheme}:${this.scheme === 'untitled' && !this.authority && !this.path.startsWith('/') ? '' : '//'}${this.authority}${this.path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
    }
    const encoded = encodeURI(this.path)
      .replace(/[?#]/g, (char) => encodeURIComponent(char))
      .replace(/^\/([a-zA-Z]):/, '/$1%3A');
    return `${this.scheme}:${this.scheme === 'untitled' && !this.authority && !this.path.startsWith('/') ? '' : '//'}${this.authority}${encoded}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
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
    if (typeof lineDelta === 'object' && lineDelta !== null) {
      characterDelta = lineDelta.characterDelta ?? 0;
      lineDelta = lineDelta.lineDelta ?? 0;
    }
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
  with(line = this.line, character = this.character) {
    if (typeof line === 'object' && line !== null) {
      character = line.character ?? this.character;
      line = line.line ?? this.line;
    }
    if (line === this.line && character === this.character) return this;
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
    if (start && !(start instanceof Position) && typeof start === 'object') {
      end = start.end ?? this.end;
      start = start.start ?? this.start;
    }
    if (start === this.start && end === this.end) return this;
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

// VS Code diagnostic metadata used by linter and refactoring extensions.
const DiagnosticTag = Object.freeze({ Unnecessary: 1, Deprecated: 2 });
class DiagnosticRelatedInformation {
  constructor(location, message) {
    this.location = location;
    this.message = message;
  }
}
const CompletionTriggerKind = Object.freeze({ Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 });
const CodeActionTriggerKind = Object.freeze({ Invoke: 1, Automatic: 2 });
const SymbolTag = Object.freeze({ Deprecated: 1 });

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
  Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24, User: 25, Issue: 26,
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
    let text;
    if (typeof value === 'function') {
      const nested = new SnippetString();
      nested._tabstop = this._tabstop;
      value(nested);
      this._tabstop = nested._tabstop;
      text = nested.value;
    } else text = SnippetString.escape(value);
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
    let fallback;
    if (typeof defaultValue === 'function') {
      const nested = new SnippetString();
      nested._tabstop = this._tabstop;
      defaultValue(nested);
      this._tabstop = nested._tabstop;
      fallback = nested.value;
    } else if (defaultValue !== undefined) fallback = SnippetString.escape(defaultValue);
    this.value += fallback === undefined
      ? String.fromCharCode(36, 123) + name + '}'
      : String.fromCharCode(36, 123) + name + ':' + fallback + '}';
    return this;
  }
}

class CancellationTokenSource {
  constructor(parent) {
    const emitter = new EventEmitter();
    this.token = { isCancellationRequested: false, onCancellationRequested: (listener, thisArg, disposables) => {
      if (!this.token.isCancellationRequested) return emitter.event(listener, thisArg, disposables);
      const subscription = CancellationToken.Cancelled.onCancellationRequested(listener, thisArg);
      if (Array.isArray(disposables)) disposables.push(subscription);
      return subscription;
    } };
    this._emitter = emitter;
    this._disposed = false;
    this._parent = parent?.onCancellationRequested(() => this.cancel());
    if (parent?.isCancellationRequested) this.cancel();
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
    this._parent?.dispose();
    this._emitter.dispose();
  }
}

// Value types shared by language tooling extensions. They are usable even when a
// corresponding provider contribution is not yet implemented by the workbench.
// Stable public enum values from the VS Code 1.85.2 declaration baseline.
const publicEnumValues = {
  "TextEditorSelectionChangeKind": {
    "Keyboard": 1,
    "Mouse": 2,
    "Command": 3
  },
  "TextEditorCursorStyle": {
    "Line": 1,
    "Block": 2,
    "Underline": 3,
    "LineThin": 4,
    "BlockOutline": 5,
    "UnderlineThin": 6
  },
  "TextEditorLineNumbersStyle": {
    "Off": 0,
    "On": 1,
    "Relative": 2
  },
  "TextEditorRevealType": {
    "Default": 0,
    "InCenter": 1,
    "InCenterIfOutsideViewport": 2,
    "AtTop": 3
  },
  "OverviewRulerLane": {
    "Left": 1,
    "Center": 2,
    "Right": 4,
    "Full": 7
  },
  "DecorationRangeBehavior": {
    "OpenOpen": 0,
    "ClosedClosed": 1,
    "OpenClosed": 2,
    "ClosedOpen": 3
  },
  "EndOfLine": {
    "LF": 1,
    "CRLF": 2
  },
  "QuickPickItemKind": {
    "Separator": -1,
    "Default": 0
  },
  "InputBoxValidationSeverity": {
    "Info": 1,
    "Warning": 2,
    "Error": 3
  },
  "CodeActionTriggerKind": {
    "Invoke": 1,
    "Automatic": 2
  },
  "DocumentHighlightKind": {
    "Text": 0,
    "Read": 1,
    "Write": 2
  },
  "SymbolKind": {
    "File": 0,
    "Module": 1,
    "Namespace": 2,
    "Package": 3,
    "Class": 4,
    "Method": 5,
    "Property": 6,
    "Field": 7,
    "Constructor": 8,
    "Enum": 9,
    "Interface": 10,
    "Function": 11,
    "Variable": 12,
    "Constant": 13,
    "String": 14,
    "Number": 15,
    "Boolean": 16,
    "Array": 17,
    "Object": 18,
    "Key": 19,
    "Null": 20,
    "EnumMember": 21,
    "Struct": 22,
    "Event": 23,
    "Operator": 24,
    "TypeParameter": 25
  },
  "SymbolTag": {
    "Deprecated": 1
  },
  "SignatureHelpTriggerKind": {
    "Invoke": 1,
    "TriggerCharacter": 2,
    "ContentChange": 3
  },
  "CompletionItemKind": {
    "Text": 0,
    "Method": 1,
    "Function": 2,
    "Constructor": 3,
    "Field": 4,
    "Variable": 5,
    "Class": 6,
    "Interface": 7,
    "Module": 8,
    "Property": 9,
    "Unit": 10,
    "Value": 11,
    "Enum": 12,
    "Keyword": 13,
    "Snippet": 14,
    "Color": 15,
    "Reference": 17,
    "File": 16,
    "Folder": 18,
    "EnumMember": 19,
    "Constant": 20,
    "Struct": 21,
    "Event": 22,
    "Operator": 23,
    "TypeParameter": 24,
    "User": 25,
    "Issue": 26
  },
  "CompletionItemTag": {
    "Deprecated": 1
  },
  "CompletionTriggerKind": {
    "Invoke": 0,
    "TriggerCharacter": 1,
    "TriggerForIncompleteCompletions": 2
  },
  "InlineCompletionTriggerKind": {
    "Invoke": 0,
    "Automatic": 1
  },
  "InlayHintKind": {
    "Type": 1,
    "Parameter": 2
  },
  "FoldingRangeKind": {
    "Comment": 1,
    "Imports": 2,
    "Region": 3
  },
  "IndentAction": {
    "None": 0,
    "Indent": 1,
    "IndentOutdent": 2,
    "Outdent": 3
  },
  "SyntaxTokenType": {
    "Other": 0,
    "Comment": 1,
    "String": 2,
    "RegEx": 3
  },
  "ConfigurationTarget": {
    "Global": 1,
    "Workspace": 2,
    "WorkspaceFolder": 3
  },
  "DiagnosticSeverity": {
    "Error": 0,
    "Warning": 1,
    "Information": 2,
    "Hint": 3
  },
  "DiagnosticTag": {
    "Unnecessary": 1,
    "Deprecated": 2
  },
  "LanguageStatusSeverity": {
    "Information": 0,
    "Warning": 1,
    "Error": 2
  },
  "ViewColumn": {
    "Active": -1,
    "Beside": -2,
    "One": 1,
    "Two": 2,
    "Three": 3,
    "Four": 4,
    "Five": 5,
    "Six": 6,
    "Seven": 7,
    "Eight": 8,
    "Nine": 9
  },
  "StatusBarAlignment": {
    "Left": 1,
    "Right": 2
  },
  "TerminalLocation": {
    "Panel": 1,
    "Editor": 2
  },
  "ExtensionKind": {
    "UI": 1,
    "Workspace": 2
  },
  "ExtensionMode": {
    "Production": 1,
    "Development": 2,
    "Test": 3
  },
  "ColorThemeKind": {
    "Light": 1,
    "Dark": 2,
    "HighContrast": 3,
    "HighContrastLight": 4
  },
  "TaskRevealKind": {
    "Always": 1,
    "Silent": 2,
    "Never": 3
  },
  "TaskPanelKind": {
    "Shared": 1,
    "Dedicated": 2,
    "New": 3
  },
  "ShellQuoting": {
    "Escape": 1,
    "Strong": 2,
    "Weak": 3
  },
  "TaskScope": {
    "Global": 1,
    "Workspace": 2
  },
  "FileType": {
    "Unknown": 0,
    "File": 1,
    "Directory": 2,
    "SymbolicLink": 64
  },
  "FilePermission": {
    "Readonly": 1
  },
  "FileChangeType": {
    "Changed": 1,
    "Created": 2,
    "Deleted": 3
  },
  "UIKind": {
    "Desktop": 1,
    "Web": 2
  },
  "LogLevel": {
    "Off": 0,
    "Trace": 1,
    "Debug": 2,
    "Info": 3,
    "Warning": 4,
    "Error": 5
  },
  "TreeItemCollapsibleState": {
    "None": 0,
    "Collapsed": 1,
    "Expanded": 2
  },
  "TreeItemCheckboxState": {
    "Unchecked": 0,
    "Checked": 1
  },
  "TerminalExitReason": {
    "Unknown": 0,
    "Shutdown": 1,
    "Process": 2,
    "User": 3,
    "Extension": 4
  },
  "EnvironmentVariableMutatorType": {
    "Replace": 1,
    "Append": 2,
    "Prepend": 3
  },
  "ProgressLocation": {
    "SourceControl": 1,
    "Window": 10,
    "Notification": 15
  },
  "TextDocumentChangeReason": {
    "Undo": 1,
    "Redo": 2
  },
  "TextDocumentSaveReason": {
    "Manual": 1,
    "AfterDelay": 2,
    "FocusOut": 3
  },
  "NotebookEditorRevealType": {
    "Default": 0,
    "InCenter": 1,
    "InCenterIfOutsideViewport": 2,
    "AtTop": 3
  },
  "NotebookCellKind": {
    "Markup": 1,
    "Code": 2
  },
  "NotebookControllerAffinity": {
    "Default": 1,
    "Preferred": 2
  },
  "NotebookCellStatusBarAlignment": {
    "Left": 1,
    "Right": 2
  },
  "DebugConsoleMode": {
    "Separate": 0,
    "MergeWithParent": 1
  },
  "DebugConfigurationProviderTriggerKind": {
    "Initial": 1,
    "Dynamic": 2
  },
  "CommentThreadCollapsibleState": {
    "Collapsed": 0,
    "Expanded": 1
  },
  "CommentMode": {
    "Editing": 0,
    "Preview": 1
  },
  "CommentThreadState": {
    "Unresolved": 0,
    "Resolved": 1
  },
  "TestRunProfileKind": {
    "Run": 1,
    "Debug": 2,
    "Coverage": 3
  }
};
const publicEnums = Object.fromEntries(Object.entries(publicEnumValues).map(([name, values]) => {
  const result = { ...values };
  for (const [key, value] of Object.entries(values)) result[value] = key;
  return [name, Object.freeze(result)];
}));

const ColorThemeKind = Object.freeze({ Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 });
const UIKind = Object.freeze({ Desktop: 1, Web: 2 });
const QuickInputButtons = Object.freeze({ Back: Object.freeze({ iconPath: undefined, tooltip: 'Back' }) });

class CallHierarchyItem {
  constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, { kind, name, detail, uri, range, selectionRange }); }
}
class CallHierarchyIncomingCall { constructor(from, fromRanges) { Object.assign(this, { from, fromRanges }); } }
class CallHierarchyOutgoingCall { constructor(to, fromRanges) { Object.assign(this, { to, fromRanges }); } }
class TypeHierarchyItem {
  constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, { kind, name, detail, uri, range, selectionRange }); }
}
class InlineCompletionItem {
  constructor(insertText, range, command) { this.insertText = insertText; this.range = range; this.command = command; }
}
class InlineCompletionList {
  constructor(items) { this.items = items; }
}
const InlineCompletionTriggerKind = Object.freeze({ Invoke: 0, Automatic: 1 });

class Color {
  constructor(red, green, blue, alpha) { this.red = red; this.green = green; this.blue = blue; this.alpha = alpha; }
}
class ColorInformation {
  constructor(range, color) { this.range = range; this.color = color; }
}
class ColorPresentation {
  constructor(label) { this.label = label; }
}
class InlayHintLabelPart {
  constructor(value) { this.value = value; }
}
class InlayHint {
  constructor(position, label, kind) { this.position = position; this.label = label; this.kind = kind; }
}
const InlayHintKind = Object.freeze({ Type: 1, Parameter: 2 });

class SemanticTokensLegend {
  constructor(tokenTypes, tokenModifiers = []) { this.tokenTypes = [...tokenTypes]; this.tokenModifiers = [...tokenModifiers]; }
}
class SemanticTokens {
  constructor(data, resultId) { this.data = data; this.resultId = resultId; }
}
class SemanticTokensEdit {
  constructor(start, deleteCount, data) { this.start = start; this.deleteCount = deleteCount; this.data = data; }
}
class SemanticTokensEdits {
  constructor(edits, resultId) { this.edits = edits; this.resultId = resultId; }
}
class SemanticTokensBuilder {
  constructor(legend) { this.legend = legend; this.tokens = []; }
  push(line, char, length, tokenType, tokenModifiers = 0) {
    if (typeof line === 'object') {
      const range = line;
      if (!this.legend || range.start.line !== range.end.line) throw new Error('Named semantic tokens require a legend and a single-line range.');
      const type = this.legend.tokenTypes.indexOf(char);
      if (type < 0) throw new Error('Unknown semantic token type.');
      let modifiers = 0;
      for (const name of length || []) {
        const index = this.legend.tokenModifiers.indexOf(name);
        if (index < 0 || index >= 32) throw new Error('Unknown semantic token modifier.');
        modifiers = (modifiers | (1 << index)) >>> 0;
      }
      return this.push(range.start.line, range.start.character, range.end.character - range.start.character, type, modifiers);
    }
    if (![line, char, length, tokenType, tokenModifiers].every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff) || length === 0) throw new Error('Invalid semantic token.');
    this.tokens.push([line, char, length, tokenType, tokenModifiers]);
  }
  build(resultId) {
    const data = []; let line = 0; let char = 0;
    for (const token of [...this.tokens].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      data.push(token[0] - line, token[0] === line ? token[1] - char : token[1], ...token.slice(2));
      [line, char] = token;
    }
    return new SemanticTokens(new Uint32Array(data), resultId);
  }
}

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
  }
  get isResolved() { return this.command !== undefined; }
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
const FoldingRangeKind = { Comment: 1, Imports: 2, Region: 3 };

const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 };
class DocumentHighlight {
  constructor(range, kind = DocumentHighlightKind.Text) {
    this.range = range;
    this.kind = kind;
  }
}

class SelectionRange {
  constructor(range, parent) {
    if (parent && !parent.range.contains(range)) throw new Error('A selection range parent must contain its child.');
    this.range = range; this.parent = parent;
  }
}
class LinkedEditingRanges { constructor(ranges, wordPattern) { this.ranges = ranges; this.wordPattern = wordPattern; } }
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

class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

const CancellationToken = Object.freeze({
  None: Object.freeze({ isCancellationRequested: false, onCancellationRequested: () => new Disposable(() => {}) }),
  Cancelled: Object.freeze({
    isCancellationRequested: true,
    onCancellationRequested: (listener, thisArg) => {
      // Already cancelled: notify asynchronously unless the subscription is disposed.
      let disposed = false;
      queueMicrotask(() => {
        if (!disposed) listener.call(thisArg);
      });
      return new Disposable(() => { disposed = true; });
    },
  }),
});

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 };

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
    get activeTerminal() {
      return undefined;
    },
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
      if (uri.scheme === 'file' || (uri.scheme === 'untitled' && doc.isUntitled)) {
        return editors.showEditor(uri.scheme === 'file' ? uri.fsPath : uri.toString(), showOptions);
      }
      if (column !== undefined || options.preserveFocus || options.preview !== undefined || selection) throw unsupportedError('window.showTextDocument.virtualOptions');
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
      track(host.events.on('editorOptionsChanged')(asExtension(data => listener.call(thisArg, { textEditor: editor(data), options: { tabSize: data.tabSize, insertSpaces: data.insertSpaces } })), thisArg, disposables)),
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

