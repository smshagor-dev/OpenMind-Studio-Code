'use strict';
// File systems for OpenMind Studio's extension host (Milestone 18): `workspace.registerFileSystemProvider`,
// `workspace.fs`, `FileType` and `FileSystemError` — a VS Code API subset, written for this app.
//
// A provider serves one custom scheme (`memfs:`, `zipfs:` ...). The app only ever sends it paths of *that* scheme,
// normalized and refused when they try to climb out of its root (`..`). A provider is **read-only unless it says
// `isReadonly: false`**; writes to a read-only provider fail with `NoPermissions` before the provider is called.
// Built-in schemes (`file`, `untitled`, `http(s)`, `data`, `vscode*`, `openmind*` ...) can't be taken.
//
// `workspace.fs` works on `file:` Uris inside the open folder (read: `workspaceRead`; write/delete: `workspaceWrite`;
// anywhere else: `filesystemOutsideWorkspace`) and on registered custom schemes (through their provider).

const fs = require('fs');
const path = require('path');
const { within, resolvedPath } = require('./guard.js');

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const RESERVED = /^(file|untitled|https?|data|mailto|javascript|about|blob|vscode.*|openmind.*|git|output|debug|walkthrough)$/i;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

class FileSystemError extends Error {
  constructor(message, code) {
    super(message || code || 'Unknown');
    this.code = code || 'Unknown';
    this.name = `FileSystemError (${this.code})`;
  }
  static FileNotFound(uri) {
    return new FileSystemError(`File not found: ${String(uri)}`, 'FileNotFound');
  }
  static FileExists(uri) {
    return new FileSystemError(`File exists: ${String(uri)}`, 'FileExists');
  }
  static FileNotADirectory(uri) {
    return new FileSystemError(`Not a directory: ${String(uri)}`, 'FileNotADirectory');
  }
  static FileIsADirectory(uri) {
    return new FileSystemError(`Is a directory: ${String(uri)}`, 'FileIsADirectory');
  }
  static NoPermissions(message) {
    return new FileSystemError(typeof message === 'string' ? message : 'No permissions', 'NoPermissions');
  }
  static Unavailable(message) {
    return new FileSystemError(typeof message === 'string' ? message : 'Unavailable', 'Unavailable');
  }
}

/**
 * A provider path, normalized: forward slashes, starting with `/`, no `.` segments; `null` when it would climb above
 * the root (`..`) or holds a NUL. The provider never sees anything else.
 */
function normalizeProviderPath(value) {
  const text = String(value || '/');
  if (text.includes('\u0000')) return null;
  const parts = [];
  for (const part of text.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function toError(error) {
  if (error instanceof FileSystemError) return error;
  if (error && error.code === 'ENOENT') return FileSystemError.FileNotFound(error.path);
  if (error && error.code === 'EEXIST') return FileSystemError.FileExists(error.path);
  if (error && error.code === 'ENOTDIR') return FileSystemError.FileNotADirectory(error.path);
  if (error && error.code === 'EISDIR') return FileSystemError.FileIsADirectory(error.path);
  if (error && (error.code === 'EPERMISSION' || error.code === 'EACCES' || error.code === 'EPERM')) {
    return FileSystemError.NoPermissions(error.message);
  }
  return new FileSystemError(error && error.message ? error.message : String(error), 'Unknown');
}

function createFileSystemApi({ host, ext, need, track, Disposable, Uri }) {
  const { state } = host;
  if (!state.fileSystems) state.fileSystems = new Map(); // scheme -> { extension, provider, readonly }

  function registerFileSystemProvider(scheme, provider, options) {
    if (typeof scheme !== 'string' || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
      throw new Error(`'${scheme}' is not a valid Uri scheme.`);
    }
    if (RESERVED.test(scheme)) throw new Error(`The '${scheme}' scheme belongs to OpenMind Studio and can't be provided by an extension.`);
    const existing = state.fileSystems.get(scheme);
    if (existing) throw new Error(`The '${scheme}' scheme already has a file system provider (${existing.extension}).`);
    for (const method of ['stat', 'readDirectory', 'readFile']) {
      if (!provider || typeof provider[method] !== 'function') throw new Error(`A file system provider needs ${method}().`);
    }
    // Writes only when the extension said so, explicitly.
    const readonly = !(options && options.isReadonly === false);
    const entry = { extension: ext.id, provider, readonly, caseSensitive: !(options && options.isCaseSensitive === false) };
    state.fileSystems.set(scheme, entry);
    host.notify('fs/registered', { extension: ext.id, scheme, readonly });
    return track(
      new Disposable(() => {
        if (state.fileSystems.get(scheme) !== entry) return;
        state.fileSystems.delete(scheme);
        host.notify('fs/unregistered', { extension: ext.id, scheme });
      }),
    );
  }

  /** The permission a `file:` path needs for `write` or read. */
  function filePermission(file, write) {
    const target = resolvedPath(file);
    const inside = state.workspaceFolders.some((folder) => within(resolvedPath(folder.path), target));
    if (!inside) return 'filesystemOutsideWorkspace';
    return write ? 'workspaceWrite' : 'workspaceRead';
  }

  function fileOf(uri, write) {
    const file = path.resolve(uri.fsPath);
    need(filePermission(file, write));
    return file;
  }

  async function onProvider(uri, op, ...args) {
    const scheme = uri.scheme;
    await host.activateByEvent?.(`onFileSystem:${scheme}`);
    const entry = state.fileSystems.get(scheme);
    if (!entry) throw FileSystemError.Unavailable(`No file system provider for '${scheme}:'.`);
    return providerCall(host, entry, op, uri.with({ path: normalizeProviderPath(uri.path) ?? '' }), ...args);
  }

  const fsApi = {
    async stat(uri) {
      if (uri.scheme !== 'file') return onProvider(uri, 'stat');
      try {
        const info = await fs.promises.stat(fileOf(uri, false));
        return { type: info.isDirectory() ? FileType.Directory : FileType.File, ctime: info.ctimeMs, mtime: info.mtimeMs, size: info.size };
      } catch (error) {
        throw toError(error);
      }
    },
    async readDirectory(uri) {
      if (uri.scheme !== 'file') return onProvider(uri, 'readDirectory');
      try {
        const entries = await fs.promises.readdir(fileOf(uri, false), { withFileTypes: true });
        return entries.map((entry) => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]);
      } catch (error) {
        throw toError(error);
      }
    },
    async readFile(uri) {
      if (uri.scheme !== 'file') return onProvider(uri, 'readFile');
      try {
        const file = fileOf(uri, false);
        const info = await fs.promises.stat(file);
        if (info.size > MAX_FILE_BYTES) throw FileSystemError.Unavailable('The file is larger than 32 MB.');
        return new Uint8Array(await fs.promises.readFile(file));
      } catch (error) {
        throw toError(error);
      }
    },
    async writeFile(uri, content, options) {
      const overwrite = options?.overwrite !== false;
      if (uri.scheme !== 'file') return onProvider(uri, 'writeFile', content, { create: true, overwrite });
      try {
        await fs.promises.writeFile(fileOf(uri, true), Buffer.from(content), { flag: overwrite ? 'w' : 'wx' });
      } catch (error) {
        throw toError(error);
      }
    },
    async delete(uri, options) {
      if (uri.scheme !== 'file') return onProvider(uri, 'delete', { recursive: !!(options && options.recursive) });
      try {
        await fs.promises.rm(fileOf(uri, true), { recursive: !!(options && options.recursive) });
      } catch (error) {
        throw toError(error);
      }
    },
    async createDirectory(uri) {
      if (uri.scheme !== 'file') return onProvider(uri, 'createDirectory');
      try {
        await fs.promises.mkdir(fileOf(uri, true), { recursive: true });
      } catch (error) {
        throw toError(error);
      }
    },
    async rename(source, target, options) {
      if (source.scheme !== target.scheme) {
        throw FileSystemError.Unavailable('Renaming across file system schemes is not supported.');
      }
      if (source.scheme !== 'file') {
        if (normalizeProviderPath(target.path) === null) throw FileSystemError.NoPermissions('That path leaves the file system provider (..).');
        return onProvider(source, 'rename', target.with({ path: normalizeProviderPath(target.path) }), { overwrite: !!options?.overwrite });
      }
      try {
        const from = fileOf(source, true);
        const to = fileOf(target, true);
        if (from === to) return;
        if (!options?.overwrite) {
          try { await fs.promises.lstat(to); throw FileSystemError.FileExists(target); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        await fs.promises.rename(from, to);
      } catch (error) { throw toError(error); }
    },
    async copy(source, target, options) {
      if (source.scheme !== target.scheme) throw FileSystemError.Unavailable('Copying across file system schemes is not supported.');
      if (source.scheme !== 'file') {
        if (normalizeProviderPath(target.path) === null) throw FileSystemError.NoPermissions('That path leaves the file system provider (..).');
        return onProvider(source, 'copy', target.with({ path: normalizeProviderPath(target.path) }), { overwrite: !!options?.overwrite });
      }
      try {
        const from = fileOf(source, false);
        const to = fileOf(target, true);
        // Directory traversal needs per-entry permission checks, particularly
        // around symlinks. Refuse it until that implementation is available.
        if ((await fs.promises.stat(from)).isDirectory()) throw FileSystemError.Unavailable('Directory copying is not supported yet.');
        await fs.promises.copyFile(from, to, options?.overwrite ? 0 : fs.constants.COPYFILE_EXCL);
      } catch (error) { throw toError(error); }
    },
    isWritableFileSystem(scheme) {
      if (scheme === 'file') return true;
      const entry = state.fileSystems.get(scheme);
      return entry ? !entry.readonly : undefined;
    },
  };
  return { registerFileSystemProvider, fs: fsApi, Uri };
}

const WRITES = new Set(['writeFile', 'delete', 'createDirectory', 'rename', 'copy']);

/** Calls `op` on the provider as its extension; a write to a read-only provider never reaches it. */
async function providerCall(host, entry, op, uri, ...args) {
  if (uri.path === '') throw FileSystemError.NoPermissions('That path leaves the file system provider (..).');
  if (WRITES.has(op) && entry.readonly) {
    throw FileSystemError.NoPermissions(`The '${uri.scheme}:' file system is read-only.`);
  }
  if (typeof entry.provider[op] !== 'function') throw FileSystemError.Unavailable(`The '${uri.scheme}:' provider has no ${op}().`);
  try {
    return await host.als.run(entry.extension, () => entry.provider[op](uri, ...args));
  } catch (error) {
    throw toError(error);
  }
}

/**
 * `host/fs`: the app asks a provider for a file of its scheme (`op`: stat | readDirectory | readFile | writeFile).
 * Contents travel as base64.
 */
async function handleFsRequest(host, params, Uri) {
  const scheme = String(params.scheme || '');
  const entry = host.state.fileSystems && host.state.fileSystems.get(scheme);
  if (!entry) throw new Error(`No file system provider for '${scheme}:'.`);
  const normalized = normalizeProviderPath(params.path);
  if (normalized === null) throw new Error(`NoPermissions: '${params.path}' leaves the '${scheme}:' file system.`);
  const uri = new Uri(scheme, params.authority || '', normalized, '', '');
  const op = String(params.op || '');
  try {
    switch (op) {
      case 'stat': {
        const info = await providerCall(host, entry, 'stat', uri);
        return { type: info.type, size: info.size, mtime: info.mtime, ctime: info.ctime, readonly: entry.readonly };
      }
      case 'readDirectory':
        return { entries: await providerCall(host, entry, 'readDirectory', uri) };
      case 'readFile': {
        const bytes = await providerCall(host, entry, 'readFile', uri);
        if (bytes.length > MAX_FILE_BYTES) throw FileSystemError.Unavailable('The file is larger than 32 MB.');
        return { base64: Buffer.from(bytes).toString('base64') };
      }
      case 'writeFile':
        await providerCall(host, entry, 'writeFile', uri, new Uint8Array(Buffer.from(String(params.base64 || ''), 'base64')), {
          create: true,
          overwrite: true,
        });
        return { ok: true };
      default:
        throw new Error(`Unknown file system operation '${op}'.`);
    }
  } catch (error) {
    const e = toError(error);
    throw new Error(`${e.code}: ${e.message}`);
  }
}

module.exports = { createFileSystemApi, handleFsRequest, normalizeProviderPath, providerCall, FileType, FileSystemError };

