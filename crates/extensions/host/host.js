'use strict';
// OpenMind Studio extension host. A separate Node.js process: it never runs inside the app's window or the
// Rust process. It talks to OpenMind Studio over JSON-RPC 2.0 on stdio (Content-Length framing, like LSP).
//
// Application -> host requests:  host/init, host/activate, host/deactivate, host/executeCommand,
//                                host/provide, host/shutdown
// Application -> host notifications: host/configurationChanged, host/document*, host/activeEditorChanged,
//                                host/workspaceFoldersChanged
// Host -> application requests:  ui/*, workspace/*, commands/execute, commands/getCommands
// Host -> application notifications: log/output, commands/registered, commands/unregistered,
//                                languages/registered, languages/unregistered, diagnostics/set

const Module = require('module');
const path = require('path');
const fs = require('fs');
const { createApi } = require('./vscode.js');

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

let currentExtension = 'host';
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => log(currentExtension, 'console', `[${level}] ${formatArgs(args)}`);
}
process.stdout.write = (chunk) => {
  log(currentExtension, 'console', String(chunk).replace(/\r?\n$/, ''));
  return true;
};
process.stderr.write = (chunk) => {
  log(currentExtension, 'console', String(chunk).replace(/\r?\n$/, ''));
  return true;
};

// An extension's uncaught error is reported and attributed, never fatal for the host.
process.on('uncaughtException', (error) => log(currentExtension, 'error', `Uncaught exception: ${error && error.stack ? error.stack : error}`));
process.on('unhandledRejection', (error) => log(currentExtension, 'error', `Unhandled rejection: ${error && error.stack ? error.stack : error}`));

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

const host = { state, request, notify, log };
const events = require('./vscode.js').createEventHub();
host.events = events;

// Which extension's `require('vscode')` is this? Decided by the requiring file's location.
const originalLoad = Module._load;
Module._load = function (requested, parent, isMain) {
  if (requested === 'vscode') {
    const file = parent && parent.filename ? path.resolve(parent.filename) : '';
    for (const [id, run] of state.running) {
      const root = path.resolve(state.extensions.get(id).path);
      if (file === root || file.startsWith(root + path.sep)) return run.api;
    }
    throw new Error("The 'vscode' module can only be used by an activated extension.");
  }
  return originalLoad.apply(this, arguments);
};

function insideExtension(descriptor, file) {
  const root = path.resolve(descriptor.path);
  const resolved = path.resolve(file);
  return resolved === root || resolved.startsWith(root + path.sep);
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
  'host/init': (params) => {
    for (const extension of params.extensions || []) state.extensions.set(extension.id, extension);
    state.configuration = params.configuration || {};
    state.workspaceFolders = params.workspaceFolders || [];
    for (const doc of params.documents || []) state.documents.set(doc.path, doc);
    state.activeEditor = params.activeEditor || null;
    return { ok: true, node: process.version };
  },

  'host/register': (params) => {
    state.extensions.set(params.extension.id, params.extension);
    return { ok: true };
  },

  'host/activate': async (params) => {
    const descriptor = state.extensions.get(params.id);
    if (!descriptor) throw new Error(`Extension '${params.id}' is not known to the extension host.`);
    if (state.running.has(params.id)) return { activated: false };
    if (!descriptor.main) return { activated: false, note: 'This extension has no code to run.' };
    const mainFile = path.resolve(descriptor.path, descriptor.main);
    const file = fs.existsSync(mainFile) || path.extname(mainFile) ? mainFile : `${mainFile}.js`;
    if (!insideExtension(descriptor, file)) throw new Error('The extension entry point is outside its folder.');
    currentExtension = descriptor.id;
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
      extension: { id: descriptor.id, extensionPath: descriptor.path, packageJSON: descriptor.manifest },
      environmentVariableCollection: undefined,
      globalState: memento(path.join(descriptor.globalStorage, 'globalState.json')),
      workspaceState: memento(path.join(descriptor.workspaceStorage || descriptor.globalStorage, 'workspaceState.json')),
      asAbsolutePath: (relative) => path.join(descriptor.path, relative),
    };
    const api = createApi(host, descriptor);
    const run = { module: null, context, api, subscriptions };
    state.running.set(descriptor.id, run);
    try {
      fs.mkdirSync(descriptor.globalStorage, { recursive: true });
      fs.mkdirSync(descriptor.logPath, { recursive: true });
      run.module = require(file);
      if (run.module && typeof run.module.activate === 'function') {
        await run.module.activate(context);
      }
    } catch (error) {
      cleanup(run);
      state.running.delete(descriptor.id);
      const message = error && error.message ? error.message : String(error);
      log(descriptor.id, 'error', `Activation failed: ${error && error.stack ? error.stack : message}`);
      throw new Error(`Activating ${descriptor.id} failed: ${message}`);
    } finally {
      currentExtension = 'host';
    }
    return { activated: true };
  },

  'host/deactivate': async (params) => deactivate(params.id),

  'host/executeCommand': async (params) => {
    const entry = state.commands.get(params.command);
    if (!entry) throw new Error(`Command '${params.command}' isn't registered by an activated extension.`);
    currentExtension = entry.id;
    try {
      return await entry.callback(...(params.args || []).map(reviveArgument));
    } finally {
      currentExtension = 'host';
    }
  },

  'host/provide': async (params) => {
    const entry = state.providers.get(params.handle);
    if (!entry) throw new Error('This language feature is no longer registered.');
    return entry.invoke(params);
  },

  'host/shutdown': async () => {
    for (const id of [...state.running.keys()]) await deactivate(id);
    setImmediate(() => process.exit(0));
    return { ok: true };
  },
};

function cleanup(run) {
  for (const disposable of run.subscriptions.splice(0).reverse()) {
    try {
      if (disposable && typeof disposable.dispose === 'function') disposable.dispose();
    } catch (error) {
      log('host', 'error', `dispose failed: ${error}`);
    }
  }
}

async function deactivate(id) {
  const run = state.running.get(id);
  if (!run) return { deactivated: false };
  currentExtension = id;
  try {
    if (run.module && typeof run.module.deactivate === 'function') await run.module.deactivate();
  } catch (error) {
    log(id, 'error', `deactivate failed: ${error && error.message ? error.message : error}`);
  } finally {
    currentExtension = 'host';
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
  return { deactivated: true };
}

// ---- notifications from the application ------------------------------------------------------------------------------

const notifications = {
  'host/configurationChanged': (params) => {
    state.configuration = params.values || {};
    events.fire('configuration', { changed: params.changed || [] });
  },
  'host/workspaceFoldersChanged': (params) => {
    state.workspaceFolders = params.folders || [];
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
    state.documents.delete(params.path);
    events.fire('documentClosed', doc || params);
  },
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
process.stdin.on('end', () => process.exit(0));
notify('host/ready', { node: process.version, pid: process.pid });
