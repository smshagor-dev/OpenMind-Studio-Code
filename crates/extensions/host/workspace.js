'use strict';
// The `workspace` namespace of OpenMind Studio's extension host (a VS Code API subset, written for this app). Moved out
// of vscode.js in Milestone 18, which added `findFiles`, `createFileSystemWatcher`, `saveAll`, `RelativePattern`,
// `workspace.fs`, `registerFileSystemProvider`, custom-scheme `openTextDocument`, and `inspect` with the contributed
// default. Nothing outside the open folder is reachable without the `filesystemOutsideWorkspace` permission.

const { unsupportedError } = require('./unsupported.js');
const path = require('path');
const { within, resolvedPath } = require('./guard.js');
const { createFileSystemApi, providerCall, normalizeProviderPath } = require('./fsprovider.js');

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

class RelativePattern {
  constructor(base, pattern) {
    this.baseUri = base && base.uri ? base.uri : base;
    this.base = typeof base === 'string' ? base : this.baseUri && this.baseUri.fsPath;
    this.pattern = pattern;
  }
}

/**
 * A glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) as a regular expression over forward-slash paths. A pattern with no `/`
 * matches the file name anywhere, as in VS Code.
 */
function globToRegExp(glob) {
  let text = String(glob).replace(/\\/g, '/');
  if (!text.includes('/')) text = `**/${text}`;
  let out = '';
  let inBraces = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '*') {
      if (text[i + 1] === '*') {
        const slash = text[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      inBraces += 1;
      out += '(?:';
    } else if (c === '}' && inBraces > 0) {
      inBraces -= 1;
      out += ')';
    } else if (c === ',' && inBraces > 0) out += '|';
    else if (c === '[') {
      const close = text.indexOf(']', i);
      if (close < 0) out += '\\[';
      else {
        out += `[${text.slice(i + 1, close).replace(/\\/g, '\\\\')}]`;
        i = close;
      }
    } else out += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/** `pattern` (a string or a RelativePattern) as a test for absolute paths. */
function matcherOf(pattern, folders) {
  if (pattern && typeof pattern === 'object' && pattern.pattern !== undefined) {
    const base = path.resolve(String(pattern.base));
    const re = globToRegExp(pattern.pattern);
    return (file) => within(base, file) && re.test(path.relative(base, file).replace(/\\/g, '/'));
  }
  const re = globToRegExp(pattern);
  return (file) =>
    folders().some((folder) => within(folder.path, file) && re.test(path.relative(folder.path, file).replace(/\\/g, '/')));
}

function guessLanguage(uriPath) {
  const ext = path.posix.extname(uriPath).slice(1).toLowerCase();
  const known = { ts: 'typescript', js: 'javascript', json: 'json', md: 'markdown', py: 'python', html: 'html', css: 'css', xml: 'xml', yaml: 'yaml', yml: 'yaml', rs: 'rust', go: 'go', php: 'php', sh: 'shellscript', txt: 'plaintext' };
  return known[ext] || 'plaintext';
}

function createWorkspaceApi(parts) {
  const { host, ext, need, track, asExtension, Disposable, EventEmitter, Uri, editors, namespace, toPath } = parts;
  const { state, request } = host;
  const { document } = editors;
  const contents = require('./contentproviders.js').create({ host, ext, need, track, Disposable, editors, guessLanguage });
  const files = createFileSystemApi({ host, ext, need, track, Disposable, Uri });

  const event = (name) => (listener, thisArg, disposables) =>
    track(host.events.on(name)(asExtension(listener), thisArg, disposables));
  const documentEvent = (name) => (listener, thisArg, disposables) => {
    need('workspaceRead');
    return track(
      host.events.on(name)(
        asExtension((data) =>
          listener(
            name === 'documentChanged'
              ? { document: document(state.documents.get(data.path) || data), contentChanges: data.contentChanges || [] }
              : document(state.documents.get(data.path) || data),
          ),
        ),
        thisArg,
        disposables,
      ),
    );
  };

  /**
   * The default a setting has in this extension's own `contributes.configuration` (its package.json as written, so
   * array and object settings, which OpenMind's Settings page doesn't show, keep their default as in VS Code).
   */
  function contributedDefault(key) {
    let manifest = ext.manifest;
    try { if (host.manifestOf) manifest = host.manifestOf(ext); } catch { /* keep the descriptor's copy */ }
    const contributed = manifest && manifest.contributes && manifest.contributes.configuration;
    for (const block of Array.isArray(contributed) ? contributed : contributed ? [contributed] : []) {
      const property = block && block.properties && block.properties[key];
      if (property && Object.prototype.hasOwnProperty.call(property, 'default')) return property.default;
    }
    return undefined;
  }

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
      return found ? nested : contributedDefault(full);
    };
    return {
      get(key, fallback) {
        const value = lookup(key);
        return value === undefined ? fallback : value;
      },
      has: (key) => lookup(key) !== undefined,
      inspect: (key) => {
        const value = lookup(key);
        const defaultValue = contributedDefault(prefix + key);
        return { key: prefix + key, defaultValue, globalValue: value !== undefined && value !== defaultValue ? value : undefined };
      },
      async update(key, value, target) {
        await request('workspace/updateConfiguration', {
          key: prefix + key,
          value: value === undefined ? null : value,
          target: target === ConfigurationTarget.Workspace || target === false ? 'workspace' : 'user',
        });
      },
    };
  }

  /** A custom-scheme document; writable filesystem resources get native editor models. */
  async function openSchemeDocument(uri) {
    need('workspaceRead');
    if (uri.scheme === 'debug') return require('./debug.js').openSource(host, uri, editors, guessLanguage);
    if (state.textContentProviders.has(uri.scheme)) return contents.open(uri);
    await host.activateByEvent?.(`onFileSystem:${uri.scheme}`);
    if (state.textContentProviders.has(uri.scheme)) return contents.open(uri);
    const entry = state.fileSystems && state.fileSystems.get(uri.scheme);
    if (!entry) throw new Error(`No file system provider for '${uri.scheme}:' (openTextDocument).`);
    const normalized = normalizeProviderPath(uri.path);
    if (normalized === null) throw new Error(`'${uri.path}' leaves the '${uri.scheme}:' file system.`);
    const clean = uri.with({ path: normalized });
    const key = clean.toString();
    const known = state.documents.get(key);
    if (known?.native && known.virtual) {
      if (entry.readonly !== known.readonly) {
        const opened = await request('workspace/openVirtualTextDocument', { extension: ext.id, uri: key, text: known.text, languageId: known.languageId, readonly: entry.readonly, version: known.version });
        if (!opened?.native || opened.path !== key) throw new Error('The native virtual document could not be opened.');
        Object.assign(known, opened);
      }
      known.fileSystemProvider = entry.id;
      return document(known);
    }
    if (known?.virtual && known.fileSystemProvider === entry.id) return document(known);
    const bytes = await providerCall(host, entry, 'readFile', clean);
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Virtual document content exceeds 32 MB.');
    const data = { fileSystemProvider: entry.id, path: key, text: Buffer.from(bytes).toString('utf8'), languageId: guessLanguage(normalized), version: 1, isDirty: false, virtual: true, readonly: entry.readonly };
    state.documents.set(key, data);
    if (entry.readonly) host.events.fire('documentOpened', data);
    if (!entry.readonly) {
      data.native = true;
      try {
        const opened = await request('workspace/openVirtualTextDocument', { extension: ext.id, uri: key, text: data.text, languageId: data.languageId });
        if (!opened?.native || opened.path !== key) throw new Error('The native virtual document could not be opened.');
        state.documents.set(key, { ...data, ...opened });
      } catch (error) { if (state.documents.get(key) === data) state.documents.delete(key); throw error; }
    }
    return document(state.documents.get(key));
  }

  const watchers = new Set();

  function folderFor(value) {
    if (value && value.scheme && value.scheme !== 'file') return undefined;
    const target = toPath(value);
    if (!target) return undefined;
    // Nested workspace roots belong to the most specific folder.
    return state.workspaceFolders.filter((folder) => within(folder.path, target))
      .sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length)[0];
  }

  const workspace = namespace('workspace', {
    get isTrusted() { return state.isTrusted === true; },
    onDidGrantWorkspaceTrust: event('workspaceTrusted'),
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
      const folder = folderFor(uri);
      return folder ? { uri: Uri.file(folder.path), name: folder.name, index: state.workspaceFolders.indexOf(folder) } : undefined;
    },
    asRelativePath(value, includeWorkspaceFolder) {
      const target = toPath(value);
      const folder = folderFor(value);
      if (!folder) return target;
      const relative = path.relative(folder.path, target).replace(/\\/g, '/');
      const include = includeWorkspaceFolder ?? state.workspaceFolders.length > 1;
      return include ? (relative ? `${folder.name}/${relative}` : folder.name) : relative;
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
      if (target?.scheme === 'untitled') {
        const known = state.documents.get(target.toString());
        if (known?.isUntitled) return document(known);
        need('workspaceWrite');
        if (!target.path || target.query || target.fragment || target.authority === 'openmind') throw new Error('Invalid or closed untitled URI.');
        const fileUri = target.with({ scheme: 'file' });
        const associatedPath = target.path.startsWith('/') ? fileUri.fsPath : undefined;
        if (associatedPath) {
          const resolved = resolvedPath(associatedPath);
          if (!state.workspaceFolders.some(folder => within(resolvedPath(folder.path), resolved))) need('filesystemOutsideWorkspace');
        }
        const data = await request('workspace/createUntitled', { extension: ext.id, content: '', language: 'plaintext', uri: target.toString(), ...(associatedPath ? { associatedPath } : {}) });
        if (!data?.isUntitled || data.path !== target.toString()) throw new Error('Invalid untitled document response.');
        state.documents.set(data.path, data);
        return document(data);
      }
      if (target === undefined || (target && typeof target === 'object' && !target.scheme && !target.fsPath && !target.uri)) {
        need('workspaceWrite');
        const options = target || {};
        for (const key of Object.keys(options)) if (!['content','language'].includes(key)) throw unsupportedError(`workspace.openTextDocument.${key}`);
        if (options.content !== undefined && typeof options.content !== 'string') throw new TypeError('Untitled content must be text.');
        if (options.language !== undefined && (typeof options.language !== 'string' || !options.language)) throw new TypeError('Invalid untitled language.');
        const data = await request('workspace/createUntitled', { extension: ext.id, content: options.content ?? '', language: options.language ?? 'plaintext' });
        if (!data?.isUntitled || !data.path?.startsWith('untitled://')) throw new Error('Invalid untitled document response.');
        state.documents.set(data.path, data);
        return document(data);
      }
      if (target && typeof target === 'object' && target.scheme && target.scheme !== 'file') return openSchemeDocument(target);
      const file = toPath(target);
      if (!file) throw new Error('openTextDocument needs a file path or a file Uri.');
      const resolved = resolvedPath(file);
      need(state.workspaceFolders.some((folder) => within(resolvedPath(folder.path), resolved)) ? 'workspaceRead' : 'filesystemOutsideWorkspace');
      const known = state.documents.get(file);
      if (known) return document(known);
      const data = await request('workspace/openTextDocument', { path: file });
      state.documents.set(file, data);
      return document(data);
    },
    /** Files in the open folder matching `include` (and not `exclude`), at most `maxResults`, as `file:` Uris. */
    async findFiles(include, exclude, maxResults) {
      need('workspaceRead');
      const describe = (pattern) =>
        pattern === undefined || pattern === null
          ? null
          : typeof pattern === 'string'
            ? { pattern, base: null }
            : { pattern: String(pattern.pattern), base: pattern.base ? String(pattern.base) : null };
      const found = await request('workspace/findFiles', {
        extension: ext.id,
        include: describe(include),
        exclude: describe(exclude),
        maxResults: Number.isInteger(maxResults) && maxResults > 0 ? maxResults : null,
      });
      return (found || []).map((file) => Uri.file(file));
    },
    /** Events for files in the open folder that match `pattern` (from the app's own file watcher; nothing new watches). */
    createFileSystemWatcher(pattern, ignoreCreate, ignoreChange, ignoreDelete) {
      need('workspaceRead');
      const matches = matcherOf(pattern, () => state.workspaceFolders);
      let disposed = false, stopProviderWatch;
      const created = new EventEmitter();
      const changed = new EventEmitter();
      const deleted = new EventEmitter();
      const watcher = {
        ignoreCreateEvents: !!ignoreCreate,
        ignoreChangeEvents: !!ignoreChange,
        ignoreDeleteEvents: !!ignoreDelete,
        onDidCreate: created.event,
        onDidChange: changed.event,
        onDidDelete: deleted.event,
        _fire(batch) {
          const each = (list, emitter, ignored) => {
            if (ignored) return;
            for (const file of list || []) {
              if (typeof file === 'string') { if (matches(path.resolve(file))) emitter.fire(Uri.file(file)); continue; }
              if (!file?.scheme) continue;
              const base = pattern?.baseUri;
              if (file.scheme === 'file') { if (matches(file.fsPath)) emitter.fire(file); }
              else if (base?.scheme === file.scheme && base.authority === file.authority) {
                const relative = path.posix.relative(base.path, file.path);
                if (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative) && globToRegExp(pattern.pattern).test(relative)) emitter.fire(file);
              }
            }
          };
          each(batch.created, created, watcher.ignoreCreateEvents);
          each(batch.changed, changed, watcher.ignoreChangeEvents);
          each(batch.deleted, deleted, watcher.ignoreDeleteEvents);
        },
        dispose() {
          if (disposed) return; disposed = true;
          try { stopProviderWatch?.(); }
          finally { watchers.delete(watcher); listener.dispose(); created.dispose(); changed.dispose(); deleted.dispose(); }
        },
      };
      const listener = host.events.on('filesChanged')(asExtension((batch) => watcher._fire(batch)));
      watchers.add(watcher);
      const base = pattern?.baseUri;
      if (base?.scheme && base.scheme !== 'file') void Promise.resolve().then(async () => {
        await host.activateByEvent?.(`onFileSystem:${base.scheme}`);
        if (disposed) return;
        const entry = state.fileSystems.get(base.scheme);
        if (!entry || typeof entry.provider.watch !== 'function') return;
        const subscription = await host.als.run(entry.extension, () => entry.provider.watch(base, { recursive: String(pattern.pattern).includes('**'), excludes: [] }));
        let stopped = false;
        const stop = () => { if (stopped) return; stopped = true; entry.watches.delete(stop); host.als.run(entry.extension, () => subscription?.dispose()); };
        if (disposed || state.fileSystems.get(base.scheme) !== entry) stop();
        else { stopProviderWatch = stop; entry.watches.add(stop); }
      }).catch(error => host.log(ext.id, 'error', `Starting filesystem watch failed: ${error.message}`));
      return track(watcher);
    },
    /** Saves every open document with unsaved edits (the user's own Save All). */
    async saveAll() {
      need('workspaceWrite');
      const answer = await request('workspace/saveAll', { extension: ext.id });
      return !!(answer && answer.saved);
    },
    fs: files.fs,
    registerFileSystemProvider: files.registerFileSystemProvider,
    registerTextDocumentContentProvider: contents.register,
    applyEdit: (edit) => editors.applyEdit(edit),
    onDidOpenTextDocument: documentEvent('documentOpened'),
    onDidCloseTextDocument: documentEvent('documentClosed'),
    onDidChangeTextDocument: documentEvent('documentChanged'),
    onDidSaveTextDocument: documentEvent('documentSaved'),
    onWillSaveTextDocument(listener, thisArg, disposables) {
      need('workspaceRead');
      if (typeof listener !== 'function') throw new TypeError('A save listener must be a function.');
      const listeners = state.willSaveListeners ||= new Set();
      const entry = { extension: ext.id, failures: 0, invoke: asExtension(async data => {
        const view = document(state.documents.get(data.path));
        if (!view || view.isClosed) return [];
        const version = view.version, pending = []; let accepting = true;
        const event = { document: view, reason: data.reason, waitUntil(value) {
          if (!accepting) throw new Error('waitUntil must be called during save event delivery.');
          if (!value || typeof value.then !== 'function') throw new TypeError('waitUntil requires a thenable.');
          const promise = Promise.resolve(value); promise.catch(() => {}); pending.push(promise);
        } };
        try {
          const returned = listener.call(thisArg, event);
          if (returned?.then) Promise.resolve(returned).catch(error => host.log(ext.id, 'error', `Save listener failed: ${error.message}`));
        } finally { accepting = false; }
        const values = await Promise.all(pending);
        if (!listeners.has(entry) || view.isClosed || view.version !== version) return [];
        const edits = values.flatMap(value => {
          if (!Array.isArray(value)) return [];
          return value;
        });
        if (!edits.length) return [];
        const edit = new editors.WorkspaceEdit(); edit.set(view.uri, edits);
        return editors.prepareTextEdit(edit) || [];
      }) };
      listeners.add(entry);
      const disposable = track(new Disposable(() => listeners.delete(entry)));
      disposables?.push(disposable);
      return disposable;
    },
  });
  return workspace;
}

async function willSaveDocument(host, params) {
  if (![1, 2, 3].includes(params.reason)) throw new TypeError('Invalid save reason.');
  const initial = host.state.documents.get(params.path);
  if (!initial || initial.version !== params.version) return { files: [] };
  const deadline = Date.now() + 1500, files = [];
  for (const entry of [...host.state.willSaveListeners || []]) {
    if (entry.failures >= 3 || !host.state.willSaveListeners.has(entry)) continue;
    if (Date.now() >= deadline || host.state.documents.get(params.path)?.version !== params.version) break;
    let timer;
    try {
      const result = await Promise.race([
        host.als.run(entry.extension, () => entry.invoke(params)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Save listener timed out.')), Math.max(0, deadline - Date.now())); }),
      ]);
      if (Date.now() >= deadline) { entry.failures++; host.log(entry.extension, 'error', 'Save listener exceeded its budget.'); }
      else if (host.state.willSaveListeners.has(entry)) files.push(...result);
    } catch (error) { entry.failures++; host.log(entry.extension, 'error', `Save listener ignored: ${error.message}`); }
    finally { clearTimeout(timer); }
  }
  return { files };
}

module.exports = { willSaveDocument, createWorkspaceApi, globToRegExp, matcherOf, RelativePattern, ConfigurationTarget, guessLanguage };

