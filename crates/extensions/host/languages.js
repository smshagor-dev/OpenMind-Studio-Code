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
  const { host, ext, need, track, Disposable, namespace, editors, types, toPath, asExtension } = parts;
  const { state, notify, request } = host;
  const { Position, Range, SnippetString, CancellationTokenSource, Uri } = types;
  const { document } = editors;
  let handleCounter = 0;
  const diagnosticCollections = state.languageDiagnostics ||= new Map();

  function selectors(selector) {
    const list = Array.isArray(selector) ? selector : [selector];
    return list.map((item) =>
      typeof item === 'string'
        ? { language: item }
        : { language: item.language, scheme: item.scheme, pattern: typeof item.pattern === 'string'
          ? item.pattern : item.pattern && { base: item.pattern.base, pattern: item.pattern.pattern } },
    );
  }

  function register(kind, selector, invoke, extra, changeEvent) {
    handleCounter += 1;
    const handle = `${ext.id}:${kind}:${handleCounter}`;
    const wireSelector = selectors(selector);
    let disposed = false;
    const changed = changeEvent?.(() => { if (!disposed) notify('languages/changed', { handle }); });
    const disposable = track(new Disposable(() => {
      disposed = true;
      try { changed?.dispose(); }
      finally {
        if (state.providers.delete(handle)) {
          host.cancelProviderRequests?.(handle);
          notify('languages/unregistered', { handle });
          require('./workbench.js').changed(host, 'languages');
        }
      }
    }));
    state.providers.set(handle, { kind, extension: ext.id, invoke: params => {
      // Accepted commands and result cleanup outlive their editor document.
      if (kind === 'workspaceSymbol' || params.action === 'incoming' || params.action === 'outgoing' || params.action === 'supertypes' || params.action === 'subtypes' || params.action === 'command' || params.action === 'release') return invoke(params);
      const doc = document(state.documents.get(params.path));
      if (!doc) throw new Error('The document is not open.');
      if (!matchSelector(selector, doc)) return null;
      return invoke(params);
    } });
    notify('languages/registered', { handle, kind, extension: ext.id, selector: wireSelector, ...extra });
    require('./workbench.js').changed(host, 'languages');
    return disposable;
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
  const locationsOut = (result) => (Array.isArray(result) ? result : result ? [result] : []).map((item) => ({
    uri: (item.uri || item.targetUri).toString(),
    path: toPath(item.uri || item.targetUri),
    range: rangeOut(item.range || item.targetRange),
    targetSelectionRange: rangeOut(item.targetSelectionRange),
    originSelectionRange: rangeOut(item.originSelectionRange),
  }));
  function locationProvider(kind, selector, provider, method) {
    need('languages');
    return register(kind, selector, async ({ path: file, position, token = cancelled }) =>
      locationsOut(await provider[method](document(state.documents.get(file)), new Position(position.line, position.character), token)));
  }

  function workspaceEditsOut(edit) {
    if (edit == null) return undefined;
    if (!(edit instanceof editors.WorkspaceEdit) || edit._notebooks.size) throw new Error('Language edits require a text-only WorkspaceEdit.');
    const guard = require('./guard.js').createGuard(ext, () => state.workspaceFolders);
    const edits = [];
    for (const [uri, values] of edit.entries()) {
      if (uri.scheme !== 'file') throw new Error('Language edits currently require file URIs.');
      need('workspaceWrite');
      guard.checkPath(uri.fsPath, true);
      const version = state.documents.get(toPath(uri))?.version;
      for (const value of values) {
        const r = rangeOut(value.range);
        if (!r || !Object.values(r).every(n => Number.isSafeInteger(n) && n >= 0) || r.startLine > r.endLine || (r.startLine === r.endLine && r.startColumn > r.endColumn)) throw new Error('Invalid language edit range.');
        edits.push({ uri: uri.toString(), range: r, newText: String(value.newText), version });
      }
    }
    return { edits };
  }

  // Keep original extension objects for lazy resolvers and command arguments. The
  // wire never revives arbitrary objects supplied by the application as commands.
  function cachedProvider(kind, selector, provide, resolve, serialize, extra, changeEvent) {
    need('languages');
    const cache = new Map(); let serial = 0;
    const remember = (file, version, value) => {
      const id = String(++serial); cache.set(id, { file, version, value });
      while (cache.size > 2000) cache.delete(cache.keys().next().value);
      return serialize(value, id, file);
    };
    return register(kind, selector, async params => {
      const { path: file, action, itemId, token = cancelled } = params;
      const doc = document(state.documents.get(file));
      if (action === 'release') { for (const id of params.itemIds || []) if (cache.get(id)?.file === file) cache.delete(id); return null; }
      if (action === 'resolve' || action === 'command') {
        const item = cache.get(itemId);
        if (!item || item.file !== file || (action === 'resolve' && item.version !== doc.version)) throw new Error('Language item is stale or no longer available.');
        if (action === 'command') {
          need('commands');
          if (item.value.disabled) throw new Error('This code action is disabled.');
          const command = Number.isSafeInteger(params.partIndex) && params.partIndex >= 0 ? item.value.label?.[params.partIndex]?.command : typeof item.value.command === 'string' ? item.value : item.value.command;
          if (!command) throw new Error('This language item has no command.');
          return host.runWorkbenchCommand(command);
        }
        const value = resolve ? await resolve(item.value, token) : item.value;
        if (token.isCancellationRequested || item.version !== doc.version) return null;
        if (value) item.value = value;
        return serialize(item.value, itemId, file);
      }
      const version = doc.version;
      const values = await provide(doc, params, token);
      if (token.isCancellationRequested || version !== doc.version) return null;
      return values?.map(value => remember(file, version, value)) || null;
    }, extra, changeEvent);
  }

  function hierarchy(kind, selector, provider) {
    need('languages');
    const items = new Map(); let next = 0;
    const store = value => {
      const id = String(++next); items.set(id, value);
      while (items.size > 4000) items.delete(items.keys().next().value);
      return { id, name: value.name, detail: value.detail, kind: value.kind, tags: value.tags,
        uri: value.uri.toString(), range: rangeOut(value.range), selectionRange: rangeOut(value.selectionRange) };
    };
    const methods = kind === 'callHierarchy'
      ? { prepare: 'prepareCallHierarchy', incoming: 'provideCallHierarchyIncomingCalls', outgoing: 'provideCallHierarchyOutgoingCalls' }
      : { prepare: 'prepareTypeHierarchy', supertypes: 'provideTypeHierarchySupertypes', subtypes: 'provideTypeHierarchySubtypes' };
    return register(kind, selector, async params => {
      const action = params.action || 'prepare';
      if (action === 'release') { for (const id of params.itemIds || []) items.delete(id); return null; }
      const token = params.token || cancelled;
      if (!Object.hasOwn(methods, action)) throw new Error('Unknown hierarchy operation.');
      let result;
      if (action === 'prepare') {
        const doc = document(state.documents.get(params.path));
        result = await provider[methods.prepare](doc, new Position(params.position.line, params.position.character), token);
      } else {
        const item = items.get(params.itemId);
        if (!item) throw new Error('Hierarchy item is stale or no longer available.');
        result = await provider[methods[action]](item, token);
      }
      if (token.isCancellationRequested) return null;
      const values = Array.isArray(result) ? result : result ? [result] : [];
      if (action === 'incoming' || action === 'outgoing') return values.map(call => ({
        item: store(action === 'incoming' ? call.from : call.to), ranges: (call.fromRanges || []).map(rangeOut),
      }));
      return values.map(store);
    });
  }

  function matchSelector(selector, doc) {
    if (Array.isArray(selector)) return Math.max(0, ...selector.map((part) => matchSelector(part, doc)));
    if (!selector || !doc || !doc.uri) return 0;
    const entry = typeof selector === 'string' ? { language: selector } : selector;
    const language = entry.language || '*';
    const scheme = entry.scheme || '*';
    if (language !== '*' && language !== doc.languageId) return 0;
    if (scheme !== '*' && scheme !== doc.uri.scheme) return 0;
    // A matching pattern filters the document; it doesn't raise wildcard scores.
    if (entry.pattern !== undefined) {
      const pattern = typeof entry.pattern === 'string' ? entry.pattern : entry.pattern?.pattern;
      if (typeof pattern !== 'string' || !pattern) return 0;
      // Uri.file() represents Windows drive paths as /C:/...; RelativePattern
      // may receive C:/... from the VS Code user profile. Normalize both.
      const normalizedPath = (value) => String(value).replace(/\\/g, '/').replace(/^\/([A-Za-z]:\/)/, '$1');
      const uriPath = normalizedPath(doc.uri.fsPath || doc.uri.path || '');
      let candidate = uriPath;
      if (typeof entry.pattern === 'object' && entry.pattern.base) {
        const base = normalizedPath(entry.pattern.base?.fsPath || entry.pattern.base);
        const relative = path.posix.relative(base, uriPath);
        if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) return 0;
        candidate = relative;
      }
      try {
        if (!globToRegExp(pattern).test(candidate)) return 0;
      } catch {
        return 0;
      }
     }
    return language === '*' ? 5 : 10;
  }

  return namespace('languages', {
    match: matchSelector,
    registerCallHierarchyProvider(selector, provider) { return hierarchy('callHierarchy', selector, provider); },
    registerTypeHierarchyProvider(selector, provider) { return hierarchy('typeHierarchy', selector, provider); },
    registerWorkspaceSymbolProvider(provider) {
      need('languages');
      const cache = new Map(); let counter = 0;
      const serialize = (value, id) => ({ id, name: value.name, kind: value.kind, tags: value.tags,
        containerName: value.containerName, uri: value.location.uri.toString(), range: rangeOut(value.location.range) });
      return register('workspaceSymbol', '*', async params => {
        if (params.action === 'release') { for (const id of params.itemIds || []) cache.delete(id); return null; }
        if (params.action === 'resolve') {
          const value = cache.get(params.itemId);
          if (!value) throw new Error('Workspace symbol is stale or no longer available.');
          const resolved = typeof provider.resolveWorkspaceSymbol === 'function' ? await provider.resolveWorkspaceSymbol(value, params.token) : value;
          if (!resolved || params.token.isCancellationRequested) return null;
          cache.set(params.itemId, resolved); return serialize(resolved, params.itemId);
        }
        const values = await provider.provideWorkspaceSymbols(String(params.query || ''), params.token);
        if (params.token.isCancellationRequested) return null;
        return (values || []).map(value => { const id = String(++counter); cache.set(id, value);
          while (cache.size > 4000) cache.delete(cache.keys().next().value);
          return serialize(value, id); });
      });
    },
    getLanguages: async () => request('workspace/getLanguages', {}),
    registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
      need('languages'); const cache = new Map(); let itemCounter = 0;
      const serialize = (item, id) => ({
        id, hasCommand: !!item.command, label: typeof item.label === 'string' ? item.label : item.label.label,
        labelDetails: typeof item.label === 'object' ? { detail: item.label.detail, description: item.label.description } : undefined,
        kind: item.kind, detail: item.detail, documentation: text(item.documentation),
        insertText: item.textEdit ? item.textEdit.newText : item.insertText instanceof SnippetString ? { snippet: item.insertText.value } : item.insertText === undefined ? undefined : String(item.insertText),
        sortText: item.sortText, filterText: item.filterText, preselect: item.preselect, commitCharacters: item.commitCharacters, tags: item.tags,
        keepWhitespace: item.keepWhitespace,
        range: item.textEdit ? rangeOut(item.textEdit.range) : item.range?.inserting
          ? { insert: rangeOut(item.range.inserting), replace: rangeOut(item.range.replacing) } : rangeOut(item.range),
        additionalTextEdits: editsOut(item.additionalTextEdits),
      });
      return register('completion', selector, async ({ path: file, position, action, itemId, context, token = cancelled }) => {
        if (action === 'command') {
          need('commands');
          const cached = cache.get(itemId); if (!cached || cached.path !== file || !cached.value.command) throw new Error('Completion command is no longer available.');
          return host.runWorkbenchCommand(cached.value.command);
        }
        if (action === 'resolve') {
          const cached = cache.get(itemId); if (!cached || cached.path !== file) throw new Error('Completion item is no longer available.');
          const result = typeof provider.resolveCompletionItem === 'function' ? await provider.resolveCompletionItem(cached.value, token) : cached.value;
          if (result) cached.value = result;
          return serialize(cached.value, itemId);
        }
        const result = await provider.provideCompletionItems(document(state.documents.get(file)), new Position(position.line, position.character), token,
          { triggerKind: context?.triggerKind ?? 0, triggerCharacter: context?.triggerCharacter });
        const items = Array.isArray(result) ? result : result?.items || [];
        return { isIncomplete: !!result?.isIncomplete, items: items.map(value => {
          const id = String(++itemCounter); cache.set(id, { path: file, value });
          while (cache.size > 5000) cache.delete(cache.keys().next().value);
          return serialize(value, id, file);
        }) };
      }, { triggerCharacters });
    },
    registerInlineCompletionItemProvider(selector, provider) {
      return cachedProvider('inlineCompletion', selector, async (doc, params, token) => {
        const selected = params.context?.selectedCompletionInfo;
        const values = await provider.provideInlineCompletionItems(doc, new Position(params.position.line, params.position.character),
          { triggerKind: params.context?.triggerKind ?? 1, selectedCompletionInfo: selected && { range: rangeIn(selected.range), text: selected.text } }, token);
        return Array.isArray(values) ? values : values?.items;
      }, undefined, (value, id) => {
        if (value.range && value.range.start.line !== value.range.end.line) throw new Error('Inline completion ranges must be single-line.');
        return { id, insertText: value.insertText instanceof SnippetString ? { snippet: value.insertText.value } : String(value.insertText ?? ''),
          range: rangeOut(value.range), filterText: value.filterText, hasCommand: !!value.command };
      });
    },
    registerRenameProvider(selector, provider) {
      need('languages');
      return register('rename', selector, async ({ path: file, position, newName, action, token = cancelled }) => {
        const doc = document(state.documents.get(file)); const version = doc.version;
        const pos = new Position(position.line, position.character);
        if (action === 'prepare') {
          if (!provider.prepareRename) return { defaultBehavior: true };
          const value = await provider.prepareRename(doc, pos, token);
          if (!value) return null;
          if (version !== doc.version || token.isCancellationRequested) return null;
          return value.range ? { range: rangeOut(value.range), placeholder: value.placeholder } : { range: rangeOut(value) };
        }
        const value = await provider.provideRenameEdits(doc, pos, newName, token);
        return version !== doc.version || token.isCancellationRequested ? null : workspaceEditsOut(value) ?? null;
      });
    },
    registerCodeActionsProvider(selector, provider, metadata) {
      const serialize = (value, id) => ({ id, title: value.title, kind: value.kind?.value,
        isPreferred: value.isPreferred, disabled: value.disabled?.reason,
        edit: workspaceEditsOut(value.edit), hasCommand: typeof value.command === 'string' || !!value.command });
      return cachedProvider('codeAction', selector, (doc, params, token) => {
        const context = { diagnostics: (params.context?.diagnostics || []).map(value => (Object.assign(new types.Diagnostic(rangeIn(value.range), value.message, value.severity), value, { range: rangeIn(value.range) }))),
          only: params.context?.only === undefined ? undefined : new types.CodeActionKind(params.context.only), triggerKind: params.context?.triggerKind ?? 1 };
        return provider.provideCodeActions(doc, rangeIn(params.range), context, token);
      }, provider.resolveCodeAction?.bind(provider), serialize,
      { providedCodeActionKinds: metadata?.providedCodeActionKinds?.map(value => value.value) });
    },
    registerCodeLensProvider(selector, provider) {
      return cachedProvider('codeLens', selector, (doc, params, token) => provider.provideCodeLenses(doc, token),
        provider.resolveCodeLens?.bind(provider), (value, id) => ({ id, range: rangeOut(value.range), title: value.command?.title, hasCommand: !!value.command }),
        undefined, provider.onDidChangeCodeLenses);
    },
    registerInlayHintsProvider(selector, provider) {
      return cachedProvider('inlayHints', selector, (doc, params, token) => provider.provideInlayHints(doc, rangeIn(params.range), token),
        provider.resolveInlayHint?.bind(provider), (value, id, file) => {
          if (value.textEdits?.length) {
            const edit = new editors.WorkspaceEdit(); edit.set(document(state.documents.get(file)).uri, value.textEdits); workspaceEditsOut(edit);
          }
          return { id, position: { line: value.position.line, character: value.position.character }, kind: value.kind,
            label: typeof value.label === 'string' ? value.label : value.label.map(part => ({ value: part.value, tooltip: text(part.tooltip), hasCommand: !!part.command,
              location: part.location && { uri: part.location.uri.toString(), range: rangeOut(part.location.range) } })),
            tooltip: text(value.tooltip), paddingLeft: value.paddingLeft, paddingRight: value.paddingRight, textEdits: editsOut(value.textEdits) };
        }, undefined, provider.onDidChangeInlayHints);
    },
    registerColorProvider(selector, provider) {
      need('languages');
      return register('color', selector, async ({ path: file, action, range, color, token = cancelled }) => {
        const doc = document(state.documents.get(file)); const version = doc.version;
        if (action === 'present') {
          const value = await provider.provideColorPresentations(new types.Color(color.red, color.green, color.blue, color.alpha), { document: doc, range: rangeIn(range) }, token);
          if (token.isCancellationRequested || doc.version !== version) return null;
          if (value?.length) {
            // Monaco inserts a presentation's label when textEdit is omitted.
            const edit = new editors.WorkspaceEdit(); edit.replace(doc.uri, rangeIn(range), ''); workspaceEditsOut(edit);
          }
          return value?.map(item => ({ label: item.label, textEdit: item.textEdit && editsOut([item.textEdit])[0], additionalTextEdits: editsOut(item.additionalTextEdits) })) || null;
        }
        const values = await provider.provideDocumentColors(doc, token);
        return token.isCancellationRequested || doc.version !== version ? null : values?.map(value => ({ range: rangeOut(value.range), color: value.color })) || null;
      });
    },
    registerDocumentSemanticTokensProvider(selector, provider, legend) {
      need('languages');
      // Full results are always legal, even when an extension also offers deltas.
      // No extension-side result lifetime is exposed by the VS Code provider API.
      return register('semanticTokens', selector, async ({ path: file, token = cancelled }) => {
        const doc = document(state.documents.get(file)); const version = doc.version;
        const value = await provider.provideDocumentSemanticTokens(doc, token);
        if (!value || token.isCancellationRequested || doc.version !== version) return null;
        const data = Array.from(value.data || []);
        if (data.length % 5 || !data.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)) throw new Error('Invalid semantic token data.');
        return { resultId: value.resultId, data };
      }, { legend }, provider.onDidChangeSemanticTokens);
    },
    registerDocumentRangeSemanticTokensProvider(selector, provider, legend) {
      need('languages');
      return register('rangeSemanticTokens', selector, async ({ path: file, range, token = cancelled }) => {
        const doc = document(state.documents.get(file)); const version = doc.version;
        const value = await provider.provideDocumentRangeSemanticTokens(doc, rangeIn(range), token);
        if (!value || token.isCancellationRequested || doc.version !== version) return null;
        const data = Array.from(value.data || []);
        if (data.length % 5 || !data.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)) throw new Error('Invalid semantic token data.');
        return { resultId: value.resultId, data };
      }, { legend });
    },
    registerHoverProvider(selector, provider) {
      need('languages');
      return register('hover', selector, async ({ path: file, position, token = cancelled }) => {
        const result = await provider.provideHover(document(state.documents.get(file)), new Position(position.line, position.character), token);
        if (!result) return null;
        return { contents: result.contents.map(text).filter((entry) => entry !== undefined), range: rangeOut(result.range) };
      });
    },
    registerDefinitionProvider(selector, provider) {
      return locationProvider('definition', selector, provider, 'provideDefinition');
    },
    registerTypeDefinitionProvider(selector, provider) {
      return locationProvider('typeDefinition', selector, provider, 'provideTypeDefinition');
    },
    registerImplementationProvider(selector, provider) {
      return locationProvider('implementation', selector, provider, 'provideImplementation');
    },
    registerDeclarationProvider(selector, provider) {
      return locationProvider('declaration', selector, provider, 'provideDeclaration');
    },
    registerSignatureHelpProvider(selector, provider, ...metadata) {
      need('languages');
      const options = typeof metadata[0] === 'object' ? metadata[0] : { triggerCharacters: metadata };
      return register('signatureHelp', selector, async ({ path: file, position, context, token = cancelled }) => {
        const value = await provider.provideSignatureHelp(document(state.documents.get(file)), new Position(position.line, position.character), token,
          { triggerKind: context?.triggerKind ?? 1, triggerCharacter: context?.triggerCharacter, isRetrigger: !!context?.isRetrigger, activeSignatureHelp: context?.activeSignatureHelp });
        if (!value) return null;
        return { activeSignature: value.activeSignature, activeParameter: value.activeParameter,
          signatures: value.signatures.map(signature => ({ label: signature.label, documentation: text(signature.documentation), activeParameter: signature.activeParameter,
            parameters: signature.parameters.map(parameter => ({ label: parameter.label, documentation: text(parameter.documentation) })) })) };
      }, { triggerCharacters: options.triggerCharacters || [], retriggerCharacters: options.retriggerCharacters || [] });
    },
    registerSelectionRangeProvider(selector, provider) {
      need('languages');
      return register('selectionRange', selector, async ({ path: file, positions, token = cancelled }) => {
        const result = await provider.provideSelectionRanges(document(state.documents.get(file)), positions.map(value => new Position(value.line, value.character)), token);
        const convert = (value, visited = new Set()) => {
          if (!value) return undefined;
          if (visited.has(value) || visited.size >= 100) throw new Error('Selection range parents contain a cycle or exceed the depth limit.');
          visited.add(value); return { range: rangeOut(value.range), parent: convert(value.parent, visited) };
        };
        if (result && result.length !== positions.length) throw new Error('Selection range count must match requested positions.');
        return result?.map(value => convert(value)) || null;
      });
    },
    registerLinkedEditingRangeProvider(selector, provider) {
      need('languages');
      return register('linkedEditing', selector, async ({ path: file, position, token = cancelled }) => {
        const result = await provider.provideLinkedEditingRanges(document(state.documents.get(file)), new Position(position.line, position.character), token);
        return result ? { ranges: result.ranges.map(rangeOut), wordPattern: result.wordPattern && { source: result.wordPattern.source, flags: result.wordPattern.flags } } : null;
      });
    },
    registerOnTypeFormattingEditProvider(selector, provider, firstTriggerCharacter, ...moreTriggerCharacters) {
      need('languages');
      if (typeof firstTriggerCharacter !== 'string' || !firstTriggerCharacter) throw new Error('On-type formatting requires a trigger character.');
      return register('onTypeFormatting', selector, async ({ path: file, position, character, options, token = cancelled }) =>
        editsOut(await provider.provideOnTypeFormattingEdits(document(state.documents.get(file)), new Position(position.line, position.character), character, formattingOptions(options), token)),
        { triggerCharacters: [firstTriggerCharacter, ...moreTriggerCharacters] });
    },
    registerDocumentLinkProvider(selector, provider) {
      need('languages'); const cache = new Map(); let itemCounter = 0;
      const serialize = (value, id) => ({ id, range: rangeOut(value.range), target: value.target?.toString(), tooltip: value.tooltip });
      return register('documentLink', selector, async ({ path: file, action, itemId, token = cancelled }) => {
        if (action === 'resolve') {
          const cached = cache.get(itemId); if (!cached || cached.path !== file) throw new Error('Document link is no longer available.');
          if (typeof provider.resolveDocumentLink !== 'function') return serialize(cached.value, itemId);
          const value = await provider.resolveDocumentLink(cached.value, token);
          if (!value) return null;
          cached.value = value; return serialize(value, itemId);
        }
        const values = await provider.provideDocumentLinks(document(state.documents.get(file)), token);
        return (values || []).map(value => {
          const id = String(++itemCounter); cache.set(id, { path: file, value });
          while (cache.size > 1000) cache.delete(cache.keys().next().value);
          return serialize(value, id, file);
        });
      });
    },
    registerReferenceProvider(selector, provider) {
      need('languages');
      return register('reference', selector, async ({ path: file, position, context, token = cancelled }) =>
        locationsOut(await provider.provideReferences(document(state.documents.get(file)), new Position(position.line, position.character),
          { includeDeclaration: !!context?.includeDeclaration }, token)));
    },
    registerDocumentHighlightProvider(selector, provider) {
      need('languages');
      return register('highlight', selector, async ({ path: file, position, token = cancelled }) => {
        const result = await provider.provideDocumentHighlights(document(state.documents.get(file)), new Position(position.line, position.character), token);
        return (result || []).map((item) => ({ range: rangeOut(item.range), kind: item.kind }));
      });
    },
    registerDocumentSymbolProvider(selector, provider, metadata) {
      need('languages');
      return register('documentSymbol', selector, async ({ path: file, token = cancelled }) => {
        const result = await provider.provideDocumentSymbols(document(state.documents.get(file)), token);
        const convert = (item) => ({
          name: item.name, detail: item.detail || '', kind: item.kind, tags: item.tags,
          range: rangeOut(item.range || item.location.range),
          selectionRange: rangeOut(item.selectionRange || item.location.range),
          children: (item.children || []).map(convert),
          containerName: item.containerName,
        });
        return (result || []).map(convert);
      }, { displayName: metadata?.label });
    },
    registerFoldingRangeProvider(selector, provider) {
      need('languages');
      return register('folding', selector, async ({ path: file, token = cancelled }) => {
        const result = await provider.provideFoldingRanges(document(state.documents.get(file)), {}, token);
        return (result || []).map((item) => ({ start: item.start, end: item.end, kind: item.kind }));
      });
    },
    /** Format Document With...: the edits for the whole document. */
    registerDocumentFormattingEditProvider(selector, provider) {
      need('languages');
      return register('formatting', selector, async ({ path: file, options, token = cancelled }) => {
        const doc = document(state.documents.get(file));
        if (!doc) throw new Error('The document is not open.');
        return editsOut(await provider.provideDocumentFormattingEdits(doc, formattingOptions(options), token));
      }, { displayName: (ext.manifest && (ext.manifest.displayName || ext.manifest.name)) || ext.id });
    },
    /** Format Selection: the edits for one range. */
    registerDocumentRangeFormattingEditProvider(selector, provider) {
      need('languages');
      return register('rangeFormatting', selector, async ({ path: file, range, options, token = cancelled }) => {
        const doc = document(state.documents.get(file));
        if (!doc) throw new Error('The document is not open.');
        return editsOut(await provider.provideDocumentRangeFormattingEdits(doc, rangeIn(range), formattingOptions(options), token));
      }, { displayName: (ext.manifest && (ext.manifest.displayName || ext.manifest.name)) || ext.id });
    },
    getDiagnostics(uri) {
      need('languages');
      const results = new Map();
      for (const stored of diagnosticCollections.values()) for (const [key, value] of stored) {
        if (uri && key !== uri.toString()) continue;
        if (!results.has(key)) results.set(key, { uri: value.uri, list: [] });
        results.get(key).list.push(...value.list);
      }
      return uri ? results.get(uri.toString())?.list || [] : [...results.values()].map(value => [value.uri, value.list]);
    },
    onDidChangeDiagnostics(listener, thisArg, disposables) {
      need('languages');
      return track(host.events.on('languageDiagnostics')(asExtension(listener), thisArg, disposables));
    },
    createDiagnosticCollection(name = `collection-${(handleCounter += 1)}`) {
      need('languages');
      const collection = `${ext.id}:${name}:${++handleCounter}`;
      const stored = new Map(); let disposed = false;
      diagnosticCollections.set(collection, stored);
      const push = (uri, list) => {
        notify('diagnostics/set', {
          collection, path: toPath(uri),
          diagnostics: list.map(item => ({ range: rangeOut(item.range), message: item.message, severity: item.severity,
            tags: item.tags?.filter(tag => tag === 1 || tag === 2), source: item.source,
            code: item.code === undefined ? undefined : String(item.code?.value ?? item.code) })),
        });
        host.events.fire('languageDiagnostics', { uris: [uri] });
      };
      const check = () => { if (disposed) throw new Error('Diagnostic collection has been disposed.'); };
      const collectionApi = {
        name,
        set(target, diagnostics) {
          check();
          if (Array.isArray(target)) {
            // Multiple entries for one URI are merged by the VS Code contract.
            const merged = new Map();
            for (const [uri, list] of target) {
              const key = uri.toString();
              if (list === undefined) merged.set(key, { uri, list: undefined });
              else { const previous = merged.get(key); merged.set(key, { uri, list: [...(previous?.list || []), ...list] }); }
            }
            for (const value of merged.values()) this.set(value.uri, value.list);
            return;
          }
          if (diagnostics === undefined) { this.delete(target); return; }
          const list = [...diagnostics]; stored.set(target.toString(), { uri: target, list }); push(target, list);
        },
        get(uri) { check(); return stored.get(uri.toString())?.list; },
        has(uri) { check(); return stored.has(uri.toString()); },
        delete(uri) { check(); stored.delete(uri.toString()); push(uri, []); },
        clear() {
          check(); const values = [...stored.values()]; stored.clear();
          for (const value of values) push(value.uri, []);
        },
        forEach(callback, thisArg) { check(); for (const value of stored.values()) callback.call(thisArg, value.uri, value.list, collectionApi); },
        dispose() {
          if (disposed) return;
          collectionApi.clear(); diagnosticCollections.delete(collection); disposed = true;
        },
      };
      return track(collectionApi);
    },
  });
}

function snapshot(host) {
  return { providers: [...host.state.providers].filter(([, value]) => ['workspaceSymbol', 'callHierarchy', 'typeHierarchy'].includes(value.kind))
    .map(([handle, value]) => ({ handle, kind: value.kind, extension: value.extension })) };
}
async function invoke(host, params) {
  if (params.op === 'cancel') return host.cancelProvide({ requestId: params.requestId });
  const entry = host.state.providers.get(params.handle);
  if (!entry || !['workspaceSymbol', 'callHierarchy', 'typeHierarchy'].includes(entry.kind)) throw new Error('Navigation provider is no longer available.');
  const { Uri } = require('./vscode.js');
  if (params.op === 'open') {
    const uri = Uri.parse(String(params.uri));
    if (uri.scheme !== 'file') throw new Error('Navigation currently opens local files only.');
    require('./guard.js').createGuard(host.state.extensions.get(entry.extension), () => host.state.workspaceFolders).checkPath(uri.fsPath, false);
    return host.request('ui/showTextDocument', { extension: entry.extension, path: uri.fsPath, preserveFocus: false });
  }
  const requestId = typeof params.requestId === 'string' ? params.requestId : require('crypto').randomUUID();
  const timeout = setTimeout(() => host.cancelProvide({ requestId }), 20000);
  try { return await host.provide({ ...params, requestId, action: params.op === 'search' ? undefined : params.op }); }
  finally { clearTimeout(timeout); }
}
module.exports = { createLanguagesApi, TextEdit, snapshot, invoke };

