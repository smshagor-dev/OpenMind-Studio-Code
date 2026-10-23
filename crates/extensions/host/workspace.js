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
              ? { document: document(state.documents.get(data.path) || data), contentChanges: [] }
              : document(state.documents.get(data.path) || data),
          ),
        ),
        thisArg,
        disposables,
      ),
    );
  };

  /** The default a setting has in this extension's own `contributes.configuration`. */
  function contributedDefault(key) {
    const contributed = ext.manifest && ext.manifest.contributes && ext.manifest.contributes.configuration;
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
      return found ? nested : undefined;
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

  /** A document of a custom scheme, read through its provider (read-only in the editor). */
  async function openSchemeDocument(uri) {
    const entry = state.fileSystems && state.fileSystems.get(uri.scheme);
    if (!entry) throw new Error(`No file system provider for '${uri.scheme}:' (openTextDocument).`);
    const normalized = normalizeProviderPath(uri.path);
    if (normalized === null) throw new Error(`'${uri.path}' leaves the '${uri.scheme}:' file system.`);
    const clean = uri.with({ path: normalized });
    const key = clean.toString();
    const bytes = await providerCall(host, entry, 'readFile', clean);
    const data = { path: key, text: Buffer.from(bytes).toString('utf8'), languageId: guessLanguage(normalized), version: 1, isDirty: false, virtual: true, readonly: entry.readonly };
    state.documents.set(key, data);
    return document(data);
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
      if (target && typeof target === 'object' && target.scheme && target.scheme !== 'file') return openSchemeDocument(target);
      if (target && typeof target === 'object' && !target.scheme && !target.fsPath && !target.uri) {
        throw unsupportedError('workspace.openTextDocument (untitled content)');
      }
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
            for (const file of list || []) if (matches(path.resolve(file))) emitter.fire(Uri.file(file));
          };
          each(batch.created, created, watcher.ignoreCreateEvents);
          each(batch.changed, changed, watcher.ignoreChangeEvents);
          each(batch.deleted, deleted, watcher.ignoreDeleteEvents);
        },
        dispose() {
          watchers.delete(watcher);
          listener.dispose();
          created.dispose();
          changed.dispose();
          deleted.dispose();
        },
      };
      const listener = host.events.on('filesChanged')(asExtension((batch) => watcher._fire(batch)));
      watchers.add(watcher);
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
    applyEdit: (edit) => editors.applyEdit(edit),
    onDidOpenTextDocument: documentEvent('documentOpened'),
    onDidCloseTextDocument: documentEvent('documentClosed'),
    onDidChangeTextDocument: documentEvent('documentChanged'),
    onDidSaveTextDocument: documentEvent('documentSaved'),
  });
  return workspace;
}

module.exports = { createWorkspaceApi, globToRegExp, matcherOf, RelativePattern, ConfigurationTarget, guessLanguage };

