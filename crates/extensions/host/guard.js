'use strict';
// Permission guard of the extension host. What it does, exactly (it is a guard, NOT a sandbox — the host is an
// ordinary Node.js process, and native addons, `process.binding` or a hand-made loader can get around it):
//   * `require('child_process')` / `cluster`        -> needs 'processExecution'
//   * `require('net' | 'http' | 'https' | 'http2' | 'tls' | 'dgram' | 'dns')`, global `fetch`/`WebSocket`,
//     `vscode.env.openExternal`                       -> needs 'network'
//   * `require('fs')` / `fs/promises` (wrapped)      -> a path in the extension's own storage is free; a path in
//     an open workspace folder needs 'workspaceRead' (reading) or 'workspaceWrite' (changing); any other path
//     — including the extension's own install folder for writing — needs 'filesystemOutsideWorkspace'
//   * `vscode.window.createTerminal`                 -> needs 'terminal'
// The message is always: Permission '<permission>' is required for this extension API.

const path = require('path');
const { fileURLToPath } = require('url');

function permissionError(permission) {
  const error = new Error(`Permission '${permission}' is required for this extension API.`);
  error.code = 'EPERMISSION';
  return error;
}

const PROCESS_MODULES = new Set(['child_process', 'cluster']);
const NETWORK_MODULES = new Set(['net', 'http', 'https', 'http2', 'tls', 'dgram', 'dns', 'dns/promises']);

/** The module name without `node:`, or the same name. */
function bareName(request) {
  return typeof request === 'string' && request.startsWith('node:') ? request.slice(5) : request;
}

/** The permission a `require(request)` from extension code needs, if any. */
function modulePermission(request) {
  const name = bareName(request);
  if (PROCESS_MODULES.has(name)) return 'processExecution';
  if (NETWORK_MODULES.has(name)) return 'network';
  return null;
}

function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function asPath(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value && typeof value === 'object' && value.protocol === 'file:') return fileURLToPath(value);
  return null; // a file descriptor or something else: nothing to check
}

/** [[argument index, writes?]] for the path arguments of a `fs` function (by its name without `Sync`). */
const RULES = {
  readFile: [[0, false]], readdir: [[0, false]], stat: [[0, false]], lstat: [[0, false]], access: [[0, false]],
  exists: [[0, false]], readlink: [[0, false]], realpath: [[0, false]], opendir: [[0, false]],
  createReadStream: [[0, false]], watch: [[0, false]], watchFile: [[0, false]],
  writeFile: [[0, true]], appendFile: [[0, true]], mkdir: [[0, true]], rmdir: [[0, true]], rm: [[0, true]],
  unlink: [[0, true]], truncate: [[0, true]], chmod: [[0, true]], chown: [[0, true]], lchown: [[0, true]],
  utimes: [[0, true]], lutimes: [[0, true]], createWriteStream: [[0, true]], mkdtemp: [[0, true]],
  rename: [[0, true], [1, true]], copyFile: [[0, false], [1, true]], cp: [[0, false], [1, true]],
  link: [[0, false], [1, true]], symlink: [[1, true]],
};

function openWrites(flags) {
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  return typeof flags === 'number' && flags !== 0;
}

/**
 * The guard of one extension. `descriptor` is what the application sent (`permissions`, `path`,
 * `globalStorage`, `workspaceStorage`, `logPath`); `folders()` gives the open workspace folders.
 */
function createGuard(descriptor, folders) {
  const granted = new Set(descriptor.permissions || []);
  const has = (permission) => granted.has(permission);
  const need = (permission) => {
    if (!has(permission)) throw permissionError(permission);
  };
  const ownStorage = [descriptor.globalStorage, descriptor.workspaceStorage, descriptor.logPath].filter(Boolean);

  /** Throws unless this extension may read (or change) `target`. */
  function checkPath(target, write) {
    if (ownStorage.some((root) => within(root, target))) return;
    const workspace = folders().some((folder) => within(folder.path, target));
    if (workspace) return need(write ? 'workspaceWrite' : 'workspaceRead');
    if (!write && descriptor.path && within(descriptor.path, target)) return; // its own files, read-only
    return need('filesystemOutsideWorkspace');
  }

  function wrapFunction(name, fn, target, promise) {
    const base = name.endsWith('Sync') ? name.slice(0, -4) : name;
    const rule = RULES[base];
    const isOpen = base === 'open';
    if (!rule && !isOpen) return fn;
    return function guarded(...args) {
      try {
        if (isOpen) {
          const p = asPath(args[0]);
          if (p !== null) checkPath(p, openWrites(args[1]));
        } else {
          for (const [index, writes] of rule) {
            const p = asPath(args[index]);
            if (p !== null) checkPath(p, writes);
          }
        }
      } catch (error) {
        if (promise) return Promise.reject(error);
        throw error;
      }
      return fn.apply(target, args);
    };
  }

  function wrapModule(real, promise) {
    const cache = new Map();
    return new Proxy(real, {
      get(target, prop) {
        const value = target[prop];
        if (prop === 'promises' && value) return wrapModule(value, true);
        if (typeof prop !== 'string' || typeof value !== 'function') return value;
        if (!cache.has(prop)) cache.set(prop, wrapFunction(prop, value, target, promise));
        return cache.get(prop);
      },
    });
  }

  const wrapped = new Map();
  /** The value `require(request)` gives this extension: a guarded `fs`, or the module itself. */
  function moduleFor(request, load) {
    const permission = modulePermission(request);
    if (permission) need(permission);
    const name = bareName(request);
    if (name === 'fs' || name === 'fs/promises') {
      if (!wrapped.has(name)) {
        const real = load();
        wrapped.set(name, name === 'fs' ? wrapModule(real, false) : wrapModule(real, true));
      }
      return wrapped.get(name);
    }
    return load();
  }

  return { has, need, checkPath, moduleFor, permissions: [...granted] };
}

module.exports = { createGuard, permissionError, modulePermission, within };
