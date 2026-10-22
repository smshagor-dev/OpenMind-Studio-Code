'use strict';
const path = require('path');
const { globToRegExp } = require('./workspace.js');
// The `languages` namespace of OpenMind Studio's extension host (a VS Code API subset, written for this app). Moved out
// of vscode.js in Milestone 18, which added document and range formatting providers and `TextEdit`. Providers only
// answer the app's requests (`host/provide`); the app keeps its bundled language servers and formatters first and
// offers an extension's formatter as one more choice (Format Document With...).

class TextEdit {
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }
  static replace(range, newText) {
    return new TextEdit(range, newText);
  }
  static insert(position, newText) {
    return new TextEdit({ start: position, end: position }, newText);
  }
  static delete(range) {
    return new TextEdit(range, '');
  }
}

function createLanguagesApi(parts) {
  const { host, ext, need, track, Disposable, namespace, editors, types, toPath } = parts;
  const { state, notify, request } = host;
  const { Position, Range, SnippetString, CancellationTokenSource, Uri } = types;
  const { document } = editors;
  let handleCounter = 0;

  function selectors(selector) {
    const list = Array.isArray(selector) ? selector : [selector];
    return list.map((item) =>
      typeof item === 'string'
        ? { language: item }
        : { language: item.language, scheme: item.scheme, pattern: typeof item.pattern === 'string' ? item.pattern : undefined },
    );
  }

  function register(kind, selector, invoke, extra) {
    handleCounter += 1;
    const handle = `${ext.id}:${kind}:${handleCounter}`;
    state.providers.set(handle, { kind, extension: ext.id, invoke });
    notify('languages/registered', { handle, kind, extension: ext.id, selector: selectors(selector), ...extra });
    return track(
      new Disposable(() => {
        if (state.providers.delete(handle)) notify('languages/unregistered', { handle });
      }),
    );
  }

  const cancelled = new CancellationTokenSource().token;
  const text = (value) =>
    value === undefined || value === null
      ? undefined
      : typeof value === 'string'
        ? value
        : value.value !== undefined
          ? { value: value.value }
          : String(value);
  const rangeOut = (range) =>
    range && { startLine: range.start.line, startColumn: range.start.character, endLine: range.end.line, endColumn: range.end.character };
  const rangeIn = (wire) => new Range(wire.startLine, wire.startColumn, wire.endLine, wire.endColumn);
  const editsOut = (result) =>
    (Array.isArray(result) ? result : []).filter((edit) => edit && edit.range).map((edit) => ({ range: rangeOut(edit.range), newText: String(edit.newText ?? '') }));
  const formattingOptions = (options) => ({ tabSize: (options && options.tabSize) || 4, insertSpaces: !options || options.insertSpaces !== false });

  function matchSelector(selector, doc) {
    if (Array.isArray(selector)) return Math.max(0, ...selector.map((part) => matchSelector(part, doc)));
    if (!selector || !doc || !doc.uri) return 0;
    const entry = typeof selector === 'string' ? { language: selector } : selector;
    const language = entry.language || '*';
    const scheme = entry.scheme || '*';
    if (language !== '*' && language !== doc.languageId) return 0;
    if (scheme !== '*' && scheme !== doc.uri.scheme) return 0;
    let patternScore = 0;
    if (entry.pattern !== undefined) {
      const pattern = typeof entry.pattern === 'string' ? entry.pattern : entry.pattern?.pattern;
      if (typeof pattern !== 'string' || !pattern) return 0;
      const uriPath = String(doc.uri.path || '').replace(/\\/g, '/');
      let candidate = uriPath;
      if (typeof entry.pattern === 'object' && entry.pattern.base) {
        const base = String(entry.pattern.base?.fsPath || entry.pattern.base).replace(/\\/g, '/');
        const relative = path.posix.relative(base, uriPath);
        if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) return 0;
        candidate = relative;
      }
      try {
        if (!globToRegExp(pattern).test(candidate)) return 0;
      } catch {
        return 0;
      }
      patternScore = 10;
    }
    const languageScore = language === '*' ? 5 : 10;
    const schemeScore = scheme === '*' ? 5 : 10;
    return Math.max(patternScore, Math.min(languageScore, schemeScore));
  }

  return namespace('languages', {
    match: matchSelector,
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
    /** Format Document With...: the edits for the whole document. */
    registerDocumentFormattingEditProvider(selector, provider) {
      need('languages');
      return register('formatting', selector, async ({ path: file, options }) => {
        const doc = document(state.documents.get(file));
        if (!doc) throw new Error('The document is not open.');
        return editsOut(await provider.provideDocumentFormattingEdits(doc, formattingOptions(options), cancelled));
      }, { displayName: (ext.manifest && (ext.manifest.displayName || ext.manifest.name)) || ext.id });
    },
    /** Format Selection: the edits for one range. */
    registerDocumentRangeFormattingEditProvider(selector, provider) {
      need('languages');
      return register('rangeFormatting', selector, async ({ path: file, range, options }) => {
        const doc = document(state.documents.get(file));
        if (!doc) throw new Error('The document is not open.');
        return editsOut(await provider.provideDocumentRangeFormattingEdits(doc, rangeIn(range), formattingOptions(options), cancelled));
      }, { displayName: (ext.manifest && (ext.manifest.displayName || ext.manifest.name)) || ext.id });
    },
    createDiagnosticCollection(name = `collection-${(handleCounter += 1)}`) {
      need('languages');
      const collection = `${ext.id}:${name}`;
      const stored = new Map();
      const push = (file, list) =>
        notify('diagnostics/set', {
          collection,
          path: file,
          diagnostics: list.map((item) => ({
            range: rangeOut(item.range),
            message: item.message,
            severity: item.severity,
            source: item.source,
            code: item.code === undefined ? undefined : String(item.code && item.code.value !== undefined ? item.code.value : item.code),
          })),
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
}

module.exports = { createLanguagesApi, TextEdit };
