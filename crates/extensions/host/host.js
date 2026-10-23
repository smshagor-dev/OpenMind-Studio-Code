'use strict';
// OpenMind Studio extension host. A separate Node.js process: it never runs inside the app's window or the
// Rust process. It talks to OpenMind Studio over JSON-RPC 2.0 on stdio (Content-Length framing, like LSP).
//
// Application -> host requests:  host/init, host/activate, host/deactivate, host/executeCommand,
//                                host/provide, host/tree, host/resolveWebviewView, host/provideTasks, host/fs,
//                                host/shutdown
// Application -> host notifications: host/configurationChanged, host/document*, host/activeEditorChanged,
//                                host/workspaceFoldersChanged, host/terminalClosed, host/filesChanged,
//                                host/taskStarted, host/taskEnded, host/webview*
// Host -> application requests:  ui/*, workspace/*, commands/execute, commands/getCommands, terminal/*,
//                                tasks/execute, secrets/* (answered by the Rust side, never by the window)
// Host -> application notifications: log/output, commands/registered, commands/unregistered,
//                                languages/registered, languages/unregistered, diagnostics/set,
//                                views/registered, views/unregistered, views/changed, views/message, views/title

const Module = require('module');
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const { createApi, disposeApi, setUnsupportedReporter } = require('./vscode.js');
const { createGuard, permissionError, modulePermission } = require('./guard.js');
const { handleTreeRequest } = require('./treeviews.js');
const { resolveWebviewView } = require('./webviews.js');
const { terminalClosed } = require('./terminals.js');
const { provideAll, taskEvent } = require('./tasks.js');
const { handleFsRequest } = require('./fsprovider.js');

// Which extension is running the current code, across awaits: what it logs, and what it may do, is decided by it.
const als = new AsyncLocalStorage();
const who = () => als.getStore() || 'host';
const realExit = process.exit.bind(process);
// An extension can't stop the host (and with it every other extension).
process.exit = () => {
  throw new Error('process.exit() is not available to extensions.');
};

const realStdoutWrite = process.stdout.write.bind(process.stdout);

// ---- framing -------------------------------------------------------------------------------------------------

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  realStdoutWrite(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
}

let nextId = 1;
const pending = new Map();

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

// ---- logging: nothing an extension prints can corrupt the protocol ---------------------------------------------

function log(extension, channel, text) {
  notify('log/output', { extension, channel, text: String(text) });
}

function formatArgs(args) {
  return args
    .map((value) => (typeof value === 'string' ? value : require('util').inspect(value, { depth: 3 })))
    .join(' ');
}

for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => log(who(), 'console', `[${level}] ${formatArgs(args)}`);
}
process.stdout.write = (chunk) => {
  log(who(), 'console', String(chunk).replace(/\r?\n$/, ''));
  return true;
};
process.stderr.write = (chunk) => {
  log(who(), 'console', String(chunk).replace(/\r?\n$/, ''));
  return true;
};

// Isolate a failing extension. Keep the shared host up for the other extensions,
// but do not silently leave its commands and providers active after a crash.
const quarantined = new Set();
function extensionFault(kind, error) {
  const id = who();
  const message = error && error.stack ? error.stack : String(error);
  log(id, 'error', `${kind}: ${message}`);
  if (id !== 'host' && state.running.has(id) && !quarantined.has(id)) {
    quarantined.add(id);
    notify('extensions/failed', { id, error: `${kind}: ${error && error.message ? error.message : String(error)}` });
    setImmediate(() => {
      void deactivate(id).catch((failure) => log(id, 'error', `Cleanup failed: ${failure}`));
    });
  }
}
process.on('uncaughtException', (error) => extensionFault('Uncaught exception', error));
process.on('unhandledRejection', (error) => extensionFault('Unhandled rejection', error));

// ---- state ---------------------------------------------------------------------------------------------------------

const state = {
  extensions: new Map(), // id -> descriptor
  running: new Map(), // id -> { module, context, api, subscriptions }
  commands: new Map(), // command -> { id (extension), callback }
  providers: new Map(), // handle -> { kind, provider }
  configuration: {},
  workspaceFolders: [],
  documents: new Map(), // uri -> document data
  activeEditor: null,
};

const host = { state, request, notify, log, als };
setUnsupportedReporter((message) => log(who(), 'error', message));
const events = require('./vscode.js').createEventHub();
host.events = events;
host.runWorkbenchCommand = async (command) => {
  const entry = state.commands.get(command.command);
  if (entry) return als.run(entry.id, () => entry.callback(...(command.arguments || [])));
  return request('commands/execute', { command: command.command, args: command.arguments || [] });
};
host.activateExtension = async (id) => {
  const caller = who();
  await activate({ id }, activations.has(caller) ? [caller] : []);
  return state.running.get(id)?.exports;
};

// Read the installed manifest without running extension code. Only enabled descriptors
// are registered with this host; manifest symlinks must stay inside that descriptor.
host.manifestOf = descriptor => {
  if (descriptor.packageJSON) return descriptor.packageJSON;
  const file = path.join(descriptor.path, 'package.json');
  if (!fs.existsSync(file)) return descriptor.manifest || {};
  if (!insideExtension(descriptor, file)) throw new Error('The extension manifest is outside its folder.');
  return descriptor.packageJSON = JSON.parse(fs.readFileSync(file, 'utf8'));
};
host.contributions = kind => {
  const result = [];
  for (const descriptor of state.extensions.values()) {
    if (!descriptor.main) continue;
    try {
      const values = host.manifestOf(descriptor).contributes?.[kind];
      if (Array.isArray(values)) for (const value of values) result.push({ ...value, extension: descriptor.id });
    } catch (error) { log(descriptor.id, 'error', `Reading activation contributions failed: ${error.message}`); }
  }
  return result;
};
host.activateByEvent = async event => {
  for (const descriptor of [...state.extensions.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const running = state.running.get(descriptor.id);
    if (!descriptor.main || (running && (!running.activating || who() === descriptor.id))) continue;
    let manifest;
    try { manifest = host.manifestOf(descriptor); }
    catch (error) { log(descriptor.id, 'error', `Reading activation events failed: ${error.message}`); continue; }
    const explicit = Array.isArray(manifest.activationEvents) && manifest.activationEvents.includes(event);
    const implicit = event.startsWith('onNotebook:') ? manifest.contributes?.notebooks?.some(value => value.type === event.slice('onNotebook:'.length))
      : event.startsWith('onDebugResolve:') ? manifest.contributes?.debuggers?.some(value => value.type === event.slice('onDebugResolve:'.length)) : false;
    if (explicit || implicit) await host.activateExtension(descriptor.id);
  }
};

// Which extension's `require('vscode')` is this? Decided by the requiring file's location.
const originalLoad = Module._load;
const guards = new Map();
const activations = new Map();
const activationWaits = new Map();
const deactivations = new Map();
const providerRequests = new Map();
host.cancelProviderRequests = (handle) => {
  for (const entry of providerRequests.values()) {
    if (entry.handle === handle) als.run(entry.extension, () => entry.source.cancel());
  }
};

function waitsFor(start, target, seen = new Set()) {
  if (start === target) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  return [...(activationWaits.get(start) || [])].some((id) => waitsFor(id, target, seen));
}
function guardOf(id) {
  if (!guards.has(id)) guards.set(id, createGuard(state.extensions.get(id), () => state.workspaceFolders));
  return guards.get(id);
}
function ownerOf(parent) {
  const file = parent && parent.filename ? path.resolve(parent.filename) : '';
  for (const [id] of state.running) {
    const root = path.resolve(state.extensions.get(id).path);
    if (file === root || file.startsWith(root + path.sep)) return id;
  }
  return null;
}
Module._load = function (requested, parent, isMain) {
  if (requested === 'vscode') {
    const owner = ownerOf(parent);
    if (owner) return state.running.get(owner).api;
    throw new Error("The 'vscode' module can only be used by an activated extension.");
  }
  const owner = ownerOf(parent);
  if (owner) {
    const args = arguments;
    return guardOf(owner).moduleFor(requested, () => originalLoad.apply(Module, args));
  }
  return originalLoad.apply(this, arguments);
};

// fetch and WebSocket are globals: whoever is running (see `als`) needs the 'network' permission.
function guardGlobals() {
  const allowed = () => {
    const id = als.getStore();
    const descriptor = id && state.extensions.get(id);
    return !descriptor || (descriptor.permissions || []).includes('network');
  };
  if (typeof globalThis.fetch === 'function') {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (...args) => (allowed() ? realFetch(...args) : Promise.reject(permissionError('network')));
  }
  if (typeof globalThis.WebSocket === 'function') {
    globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
      construct(target, args) {
        if (!allowed()) throw permissionError('network');
        return Reflect.construct(target, args);
      },
    });
  }
}
guardGlobals();

function insideExtension(descriptor, file) {
  // Resolve symlinks as well as "..": a VSIX entry point must not escape
  // the installed extension directory through a junction or symlink.
  const root = fs.realpathSync(descriptor.path);
  const resolved = fs.realpathSync(file);
  const relative = path.relative(root, resolved);
  return relative !== '' && relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function memento(file) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  };
  return {
    keys: () => Object.keys(data),
    get: (key, fallback) => (key in data ? data[key] : fallback),
    update: async (key, value) => {
      if (value === undefined) delete data[key];
      else data[key] = value;
      save();
    },
    setKeysForSync: () => {},
  };
}

// The window sends a file it was asked about as { __uri: <path> }; extensions expect a vscode.Uri.
function reviveArgument(value) {
  if (value && typeof value === 'object' && typeof value.__uri === 'string') {
    return require('./vscode.js').Uri.file(value.__uri);
  }
  return value;
}

// ---- requests from the application ---------------------------------------------------------------------------------

const handlers = {
  'host/workbench': (params) => require('./workbench.js').handle(host, params),
  'host/init': (params) => {
    state.isTrusted = params.isTrusted === true;
    for (const extension of params.extensions || []) state.extensions.set(extension.id, extension);
    state.configuration = params.configuration || {};
    state.workspaceFolders = params.workspaceFolders || [];
    for (const doc of params.documents || []) state.documents.set(doc.path, doc);
    state.activeEditor = params.activeEditor || null;
    return { ok: true, node: process.version };
  },

  'host/register': (params) => {
    // A reinstalled extension may have new permissions and a different root.
    // Do not reuse a guard built for an earlier version of its descriptor.
    guards.delete(params.extension.id);
    state.extensions.set(params.extension.id, params.extension);
    events.fire('extensions', undefined);
    return { ok: true };
  },

  'host/unregister': async (params) => {
    await deactivate(params.id);
    state.extensions.delete(params.id);
    guards.delete(params.id);
    events.fire('extensions', undefined);
    return { ok: true };
  },

  'host/activate': (params) => als.run(params.id, () => activate(params)),

  'host/deactivate': async (params) => deactivate(params.id),

  'host/executeCommand': async (params) => {
    const entry = state.commands.get(params.command);
    if (!entry) throw new Error(`Command '${params.command}' isn't registered by an activated extension.`);
    return als.run(entry.id, async () => {
      try {
        return await entry.callback(...(params.args || []).map(reviveArgument));
      } catch (error) {
        log(entry.id, 'error', `Command '${params.command}' failed: ${error && error.stack ? error.stack : error}`);
        throw error;
      }
    });
  },

  'host/provide': async (params) => {
    const entry = state.providers.get(params.handle);
    if (!entry) throw new Error('This language feature is no longer registered.');
    const id = typeof params.requestId === 'string' && params.requestId ? params.requestId : Symbol('language request');
    if (providerRequests.has(id)) throw new Error('Duplicate language request identifier.');
    const source = new (require('./vscode.js').CancellationTokenSource)();
    providerRequests.set(id, { source, extension: entry.extension, handle: params.handle });
    let cancellation;
    const cancelled = new Promise((resolve) => {
      cancellation = source.token.onCancellationRequested(() => resolve(null));
    });
    try {
      const result = await Promise.race([
        als.run(entry.extension, () => entry.invoke({ ...params, token: source.token })),
        cancelled,
      ]);
      return source.token.isCancellationRequested ? null : result;
    } finally {
      providerRequests.delete(id);
      cancellation.dispose();
      source.dispose();
    }
  },

  'host/cancelProvide': (params) => {
    const entry = providerRequests.get(params.requestId);
    if (entry) als.run(entry.extension, () => entry.source.cancel());
    return { ok: true };
  },

  'host/tree': async (params) => {
    const tree = state.trees && state.trees.get(params.view);
    return als.run(tree ? tree.extension : 'host', () => handleTreeRequest(state, params));
  },

  // Milestone 18
  'host/resolveWebviewView': async (params) => resolveWebviewView(host, params),
  'host/provideTasks': async (params) => ({ tasks: await provideAll(host, params.type || null) }),
  'host/fs': async (params) => handleFsRequest(host, params, require('./vscode.js').Uri),

  'host/shutdown': async () => {
    for (const id of [...state.running.keys()]) await deactivate(id);
    setImmediate(() => realExit(0));
    return { ok: true };
  },
};

function activate(params, chain = []) {
  const id = params.id;
  if (chain.includes(id)) {
    return Promise.reject(new Error(`Circular extension dependency: ${[...chain, id].join(' -> ')}`));
  }
  const parent = chain[chain.length - 1];
  if (parent) {
    if (waitsFor(id, parent)) {
      return Promise.reject(new Error(`Circular extension dependency: ${parent} -> ${id}`));
    }
    if (!activationWaits.has(parent)) activationWaits.set(parent, new Set());
    activationWaits.get(parent).add(id);
  }
  let pendingActivation = activations.get(id);
  if (!pendingActivation) {
    const previousDeactivation = deactivations.get(id);
    // Publish before entering extension code or visiting dependencies. All callers
    // observe the same result, including activation failures.
    pendingActivation = Promise.resolve().then(async () => {
      if (previousDeactivation) await previousDeactivation;
      return als.run(id, () => activateOnce(params, chain));
    }).finally(() => {
      activations.delete(id);
      activationWaits.delete(id);
    });
    activations.set(id, pendingActivation);
  }
  return pendingActivation.finally(() => {
    if (parent) activationWaits.get(parent)?.delete(id);
  });
}

async function activateOnce(params, chain) {
  if (quarantined.has(params.id)) throw new Error(`Extension '${params.id}' failed in this host session. Restart the extension host to retry.`);
  {
    const descriptor = state.extensions.get(params.id);
    if (!descriptor) throw new Error(`Extension '${params.id}' is not known to the extension host.`);
    if (chain.includes(params.id)) {
      throw new Error(`Circular extension dependency: ${[...chain, params.id].join(' -> ')}`);
    }
    if (state.running.has(params.id)) {
      const current = state.running.get(params.id);
      if (current.activating) throw new Error(`Extension '${params.id}' is still activating; retry after activation finishes.`);
      return { activated: false };
    }
    // VS Code's extensionDependencies must be present and activated first. A warning
    // in the extension list alone is insufficient: activation would otherwise fail
    // later with an opaque missing command/API error.
    const dependencies = descriptor.manifest && descriptor.manifest.extensionDependencies || [];
    for (const name of dependencies) {
      const dependencyId = String(name).toLowerCase();
      const dependency = state.extensions.get(dependencyId);
      if (!dependency) throw new Error(`Extension '${params.id}' requires '${name}', which is not enabled or installed.`);
      if (!dependency.main) throw new Error(`Extension '${params.id}' requires '${name}', which has no runnable entry point.`);
      await activate({ id: dependencyId }, [...chain, params.id]);
    }
    if (!descriptor.main) return { activated: false, note: 'This extension has no code to run.' };
    const mainFile = path.resolve(descriptor.path, descriptor.main);
    const file = fs.existsSync(mainFile) || path.extname(mainFile) ? mainFile : `${mainFile}.js`;
    if (!insideExtension(descriptor, file)) throw new Error('The extension entry point is outside its folder.');
    const packageFile = path.join(descriptor.path, 'package.json');
    if (fs.existsSync(packageFile)) {
      if (!insideExtension(descriptor, packageFile)) throw new Error('The extension manifest is outside its folder.');
      descriptor.packageJSON = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    }
    if (state.isTrusted !== true && descriptor.packageJSON?.capabilities?.untrustedWorkspaces?.supported === false) {
      throw new Error(`Extension '${descriptor.id}' requires a trusted workspace.`);
    }
    const subscriptions = [];
    const context = {
      subscriptions,
      extensionPath: descriptor.path,
      extensionUri: require('./vscode.js').Uri.file(descriptor.path),
      globalStorageUri: require('./vscode.js').Uri.file(descriptor.globalStorage),
      storageUri: descriptor.workspaceStorage ? require('./vscode.js').Uri.file(descriptor.workspaceStorage) : undefined,
      logUri: require('./vscode.js').Uri.file(descriptor.logPath),
      globalStoragePath: descriptor.globalStorage,
      logPath: descriptor.logPath,
      extension: { id: descriptor.id, extensionPath: descriptor.path, packageJSON: descriptor.packageJSON || descriptor.manifest },
      environmentVariableCollection: undefined,
      globalState: memento(path.join(descriptor.globalStorage, 'globalState.json')),
      workspaceState: memento(path.join(descriptor.workspaceStorage || descriptor.globalStorage, 'workspaceState.json')),
      asAbsolutePath: (relative) => path.join(descriptor.path, relative),
      secrets: secretStorage(descriptor.id),
    };
    const api = createApi(host, descriptor);
    const run = { module: null, exports: undefined, context, api, subscriptions, activating: true };
    state.running.set(descriptor.id, run);
    try {
      fs.mkdirSync(descriptor.globalStorage, { recursive: true });
      fs.mkdirSync(descriptor.logPath, { recursive: true });
      run.module = require(file);
      if (run.module && typeof run.module.activate === 'function') {
        run.exports = await run.module.activate(context);
      } else {
        run.exports = run.module;
      }
      run.activating = false;
    } catch (error) {
      cleanup(run);
      state.running.delete(descriptor.id);
      try { purgeExtensionModules(descriptor); }
      catch (cacheError) { log(descriptor.id, 'error', `Couldn't clear failed extension module cache: ${cacheError}`); }
      const message = error && error.message ? error.message : String(error);
      log(descriptor.id, 'error', `Activation failed: ${error && error.stack ? error.stack : message}`);
      throw new Error(`Activating ${descriptor.id} failed: ${message}`);
    }
    return { activated: true };
  }

}

/**
 * `context.secrets`: strings kept for this extension only. The app's Rust side stores them encrypted (Windows DPAPI)
 * under this extension's id; they never reach the app's window, logs or diagnostics.
 */
function secretStorage(extensionId) {
  const changed = new (require('./vscode.js').EventEmitter)();
  const checkKey = (key) => {
    if (typeof key !== 'string' || key === '' || key.length > 256) throw new Error('A secret key must be a string of 1 to 256 characters.');
    return key;
  };
  return {
    async get(key) {
      const answer = await request('secrets/get', { extension: extensionId, key: checkKey(key) });
      return answer && typeof answer.value === 'string' ? answer.value : undefined;
    },
    async store(key, value) {
      if (typeof value !== 'string') throw new Error('A secret value must be a string.');
      if (value.length > 64 * 1024) throw new Error('A secret value may not be longer than 64 KB.');
      await request('secrets/store', { extension: extensionId, key: checkKey(key), value });
      changed.fire({ key });
    },
    async delete(key) {
      await request('secrets/delete', { extension: extensionId, key: checkKey(key) });
      changed.fire({ key });
    },
    async keys() {
      const answer = await request('secrets/keys', { extension: extensionId });
      return Array.isArray(answer && answer.keys) ? answer.keys : [];
    },
    onDidChange: changed.event,
  };
}

function purgeExtensionModules(descriptor) {
  // Node caches both the entry module and its local dependencies. Without
  // clearing them, a VSIX update keeps executing the old implementation.
  const root = fs.realpathSync(descriptor.path);
  for (const file of Object.keys(require.cache)) {
    let real;
    try { real = fs.realpathSync(file); } catch { real = path.resolve(file); }
    const relative = path.relative(root, real);
    if (relative === '' || (relative !== '..' &&
        !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
      delete require.cache[file];
    }
  }
}

function cleanup(run) {
  als.run(run.context.extension.id, () => {
    disposeApi(run.api);
    for (const disposable of run.subscriptions.splice(0).reverse()) {
      try {
        if (disposable && typeof disposable.dispose === 'function') disposable.dispose();
      } catch (error) {
        log(run.context.extension.id, 'error', `dispose failed: ${error}`);
      }
    }
  });
}

function deactivate(id) {
  if (deactivations.has(id)) return deactivations.get(id);
  // Capture the current activation; later requests wait for this teardown.
  const activation = activations.get(id);
  const operation = Promise.resolve().then(async () => {
    if (activation) await activation.catch(() => {});
    return deactivateOnce(id);
  }).finally(() => deactivations.delete(id));
  deactivations.set(id, operation);
  return operation;
}

async function deactivateOnce(id) {
  const run = state.running.get(id);
  if (!run) return { deactivated: false };
  for (const entry of providerRequests.values()) {
    if (entry.extension === id) als.run(id, () => entry.source.cancel());
  }
  try {
    if (run.module && typeof run.module.deactivate === 'function') {
      await als.run(id, () => run.module.deactivate());
    }
  } catch (error) {
    log(id, 'error', `deactivate failed: ${error && error.message ? error.message : error}`);
  }
  cleanup(run);
  for (const [command, entry] of state.commands) {
    if (entry.id === id) {
      state.commands.delete(command);
      notify('commands/unregistered', { command });
    }
  }
  for (const [handle, entry] of state.providers) {
    if (entry.extension === id) {
      state.providers.delete(handle);
      notify('languages/unregistered', { handle });
    }
  }
  state.running.delete(id);
  const descriptor = state.extensions.get(id);
  if (descriptor) {
    try { purgeExtensionModules(descriptor); }
    catch (error) { log(id, 'error', `Couldn't clear extension module cache: ${error}`); }
  }
  return { deactivated: true };
}

// ---- notifications from the application ------------------------------------------------------------------------------

const notifications = {
  'host/configurationChanged': (params) => {
    state.configuration = params.values || {};
    events.fire('configuration', { changed: params.changed || [] });
  },
  'host/workspaceFoldersChanged': (params) => {
    const previous = state.workspaceFolders.map(folder => folder.path).sort();
    state.workspaceFolders = params.folders || [];
    if (JSON.stringify(previous) !== JSON.stringify(state.workspaceFolders.map(folder => folder.path).sort())) state.isTrusted = false;
    for (const domain of ['tests', 'scm', 'notebooks', 'debug']) require('./workbench.js').changed(host, domain);
    events.fire('workspaceFolders', {});
  },
  'host/documentOpened': (params) => {
    state.documents.set(params.path, params);
    events.fire('documentOpened', params);
  },
  'host/documentChanged': (params) => {
    state.documents.set(params.path, { ...state.documents.get(params.path), ...params });
    events.fire('documentChanged', params);
  },
  'host/documentSaved': (params) => {
    events.fire('documentSaved', params);
  },
  'host/documentClosed': (params) => {
    const doc = state.documents.get(params.path);
    require('./contentproviders.js').close(host, doc);
    state.documents.delete(params.path);
    events.fire('documentClosed', doc || params);
  },
  'host/selectionChanged': (params) => {
    if (state.activeEditor && state.activeEditor.path === params.path) {
      state.activeEditor = { ...state.activeEditor, selections: params.selections || [] };
    }
    events.fire('selectionChanged', params);
  },
  'host/webviewMessage': (params) => events.fire('webviewMessage', params),
  'host/webviewDisposed': (params) => events.fire('webviewDisposed', params),
  'host/webviewViewState': (params) => events.fire('webviewViewState', params),
  'host/terminalClosed': (params) => terminalClosed(host, params),
  'host/filesChanged': (params) => events.fire('filesChanged', params),
  'host/taskStarted': (params) => taskEvent(host, 'host/taskStarted', params),
  'host/taskEnded': (params) => taskEvent(host, 'host/taskEnded', params),
  'host/activeEditorChanged': (params) => {
    state.activeEditor = params.editor || null;
    events.fire('activeEditor', { editor: state.activeEditor });
  },
};

// ---- read loop ---------------------------------------------------------------------------------------------------------

async function dispatch(message) {
  if (message.method && message.id !== undefined) {
    const handler = handlers[message.method];
    try {
      if (!handler) throw new Error(`Unknown request ${message.method}`);
      const result = await handler(message.params || {});
      send({ jsonrpc: '2.0', id: message.id, result: result === undefined ? null : result });
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error && error.message ? error.message : String(error) } });
    }
  } else if (message.method) {
    const handler = notifications[message.method];
    if (handler) {
      try {
        handler(message.params || {});
      } catch (error) {
        log('host', 'error', `${message.method} failed: ${error}`);
      }
    }
  } else if (message.id !== undefined) {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message || 'request failed'));
    else waiting.resolve(message.result);
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.slice(headerEnd + 4 + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch (error) {
      log('host', 'error', `Invalid message: ${error}`);
      continue;
    }
    dispatch(message);
  }
});
process.stdin.on('end', () => realExit(0));
notify('host/ready', { node: process.version, pid: process.pid });


