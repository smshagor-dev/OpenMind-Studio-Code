'use strict';
// VS Code API value types: the basics (disposables, events, Uri, positions and ranges, diagnostics, markdown,
// completion items, snippets, cancellation). Split out of vscode.js, which re-exports them.
const path = require('path');

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

module.exports = { Disposable, EventEmitter, createEventHub, Uri, Position, Range, Selection, Location, DiagnosticSeverity, Diagnostic, DiagnosticTag, DiagnosticRelatedInformation, CompletionTriggerKind, CodeActionTriggerKind, SymbolTag, MarkdownString, Hover, CompletionItemKind, CompletionItem, CompletionList, SnippetString, CancellationTokenSource, CancellationError, CancellationToken };
