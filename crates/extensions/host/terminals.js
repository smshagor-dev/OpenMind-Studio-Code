'use strict';
// Terminals for OpenMind Studio's extension host (Milestone 18): `window.createTerminal`, `window.terminals`,
// `window.onDidOpenTerminal` / `onDidCloseTerminal` — a VS Code API subset, written for this app. Everything needs
// the `terminal` permission. The app creates an ordinary integrated terminal (OpenMind's shell, the portable runtimes
// first on *that* terminal's PATH, nothing else changed); the working folder must be inside the open folder. Text an
// extension sends that would run a command (`addNewLine`) is shown to the user first, who allows or refuses it — no
// command runs hidden. Not supported (they throw the "not supported" message): a custom shell (`shellPath`,
// `shellArgs`), environment changes (`env`), pseudoterminals (`pty`), and `window.createTerminal` from a location
// other than the terminal panel.

const path = require('path');
const { within } = require('./guard.js');

let counter = 0;

const { unsupportedError } = require('./unsupported.js');

function createTerminalApi({ host, ext, need, track, Disposable, EventEmitter, namespace, asExtension }) {
  const { request, notify, state } = host;
  if (!state.terminals) state.terminals = new Map(); // id -> { extension, terminal, closed() }

  /** Normalizes `createTerminal(name, shellPath, shellArgs)` and `createTerminal(options)`. */
  function optionsOf(nameOrOptions, shellPath, shellArgs) {
    if (typeof nameOrOptions === 'object' && nameOrOptions !== null) {
      const o = nameOrOptions;
      if (o.pty && (typeof o.pty.open !== 'function' || typeof o.pty.close !== 'function' || typeof o.pty.onDidWrite !== 'function')) throw new TypeError('A pseudoterminal requires open(), close() and onDidWrite.');
      if (o.shellPath) throw unsupportedError('TerminalOptions.shellPath');
      if (o.shellArgs) throw unsupportedError('TerminalOptions.shellArgs');
      if (o.env && Object.keys(o.env).length > 0) throw unsupportedError('TerminalOptions.env');
      return { name: o.name, cwd: o.cwd, pty: o.pty };
    }
    if (shellPath) throw unsupportedError('window.createTerminal (shellPath)');
    if (shellArgs) throw unsupportedError('window.createTerminal (shellArgs)');
    return { name: nameOrOptions, cwd: undefined };
  }

  /** The terminal's folder: the open folder, or a folder inside it. */
  function cwdOf(value) {
    const folders = state.workspaceFolders;
    if (value === undefined || value === null) return folders[0] ? folders[0].path : null;
    const raw = typeof value === 'string' ? value : value.fsPath;
    const resolved = path.resolve(String(raw));
    if (!folders.some((folder) => within(folder.path, resolved))) {
      throw new Error(`A terminal's folder must be inside the open folder: ${resolved}`);
    }
    return resolved;
  }

  function createTerminal(nameOrOptions, shellPath, shellArgs) {
    need('terminal');
    const options = optionsOf(nameOrOptions, shellPath, shellArgs);
    counter += 1;
    const id = `${ext.id}#term-${counter}`;
    const name = String(options.name || ext.manifest.displayName || ext.manifest.name || 'Extension');
    const cwd = cwdOf(options.cwd);
    let exitStatus;
    let terminalState = Object.freeze({ isInteractedWith: false });
    let closed = false, ptyOpened = false, ptyClosed = false;
    let dimensions = { columns: 80, rows: 24 }, pendingInput = '';
    const subscriptions = [];
    const pty = options.pty;
    const owned = fn => host.als.run(ext.id, fn);
    function cleanupPty(callClose) {
      if (ptyClosed || !pty) return; ptyClosed = true;
      for (const subscription of subscriptions.splice(0)) { try { owned(() => subscription?.dispose()); } catch (error) { host.log(ext.id, 'error', `Pseudoterminal cleanup failed: ${error.message}`); } }
      if (callClose && ptyOpened) { try { owned(() => pty.close()); } catch (error) { host.log(ext.id, 'error', `Pseudoterminal close failed: ${error.message}`); } }
    }

    const created = request('terminal/create', { extension: ext.id, id, name, cwd, ...(pty ? { pseudo: true } : {}) }).catch((error) => {
      closed = true;
      throw error;
    });
    // `processId` is what VS Code offers; a creation failure surfaces there (and on sendText).
    const processId = created.then((answer) => (answer && typeof answer.pid === 'number' ? answer.pid : undefined));
    processId.catch(() => {});

    const terminal = namespace('Terminal', {
      name,
      processId,
      creationOptions: Object.freeze({ name, cwd }),
      get exitStatus() {
        return exitStatus;
      },
      get state() { return terminalState; },
      shellIntegration: undefined,
      /** Types `text`; with `addNewLine` (the default) it would run, so the user is asked first. */
      async sendText(text, addNewLine = true) {
        need('terminal');
        if (closed) throw new Error(`The terminal '${name}' is closed.`);
        await created;
        const answer = await request('terminal/sendText', {
          extension: ext.id,
          id,
          text: String(text),
          addNewLine: addNewLine !== false,
        });
        return answer && answer.sent === true;
      },
      show(preserveFocus) {
        if (!closed) notify('terminal/show', { extension: ext.id, id, preserveFocus: !!preserveFocus });
      },
      hide() {},
      dispose() {
        if (closed) return;
        closed = true; cleanupPty(true);
        notify('terminal/dispose', { extension: ext.id, id });
        finish(undefined);
      },
    });

    function finish(code) {
      if (!state.terminals.has(id)) return;
      state.terminals.delete(id);
      exitStatus = { code, reason: 0 };
      if (state.activeTerminalId === id) activeTerminalChanged(host, { id: null });
      host.events.fire('terminalClosed', { terminal });
    }

    state.terminals.set(id, {
      extension: ext.id,
      terminal,
      ready: false,
      stateChanged() {
        if (closed || terminalState.isInteractedWith) return;
        terminalState = Object.freeze({ isInteractedWith: true });
        if (state.terminals.get(id)?.ready) host.events.fire('terminalState', { terminal, extension: ext.id });
      },
      ptyEvent(params) {
        if (!pty || closed || ptyClosed) return;
        if (params.event === 'close') { terminal.dispose(); return; }
        if (params.event === 'resize' && Number.isInteger(params.columns) && params.columns > 0 && Number.isInteger(params.rows) && params.rows > 0) {
          dimensions = { columns: params.columns, rows: params.rows };
          if (ptyOpened) owned(() => pty.setDimensions?.(dimensions));
        }
        if (params.event === 'input' && typeof params.data === 'string') {
          if (ptyOpened) owned(() => pty.handleInput?.(params.data));
          else pendingInput = (pendingInput + params.data).slice(-65536);
        }
      },
      closed: (code) => {
        closed = true; cleanupPty(true);
        finish(code);
      },
    });
    track(new Disposable(() => terminal.dispose()));
    created.then(
      asExtension(() => {
        if (closed) return;
        state.terminals.get(id).ready = true;
        host.events.fire('terminalOpened', { terminal });
        if (closed) return;
        if (state.activeTerminalId === id) host.events.fire('activeTerminal', {});
        if (closed) return;
        if (terminalState.isInteractedWith) host.events.fire('terminalState', { terminal, extension: ext.id });
        if (closed || !pty) return;
        try {
          subscriptions.push(pty.onDidWrite(asExtension(value => {
            if (closed || ptyClosed) return;
            if (typeof value !== 'string') throw new TypeError('Pseudoterminal output must be text.');
            for (let offset = 0; offset < value.length;) {
              let end = Math.min(offset + 65536, value.length);
              if (end < value.length && value.charCodeAt(end - 1) >= 0xD800 && value.charCodeAt(end - 1) <= 0xDBFF) end--;
              notify('terminal/ptyWrite', { extension: ext.id, id, data: value.slice(offset, end) }); offset = end;
            }
          })));
          if (pty.onDidClose) subscriptions.push(pty.onDidClose(asExtension(code => {
            if (closed) return; closed = true; cleanupPty(false);
            notify('terminal/ptyExit', { extension: ext.id, id, code: Number.isInteger(code) ? code : undefined }); finish(code);
          })));
          ptyOpened = true; pty.open(dimensions);
          if (pendingInput && !closed) { pty.handleInput?.(pendingInput); pendingInput = ''; }
        } catch (error) {
          closed = true; cleanupPty(true); notify('terminal/ptyExit', { extension: ext.id, id, code: 1 }); finish(1);
          host.log(ext.id, 'error', `Opening pseudoterminal failed: ${error.message}`);
        }
      }),
      (error) => {
        state.terminals.delete(id);
        if (state.activeTerminalId === id) activeTerminalChanged(host, { id: null });
        host.log(ext.id, 'error', `Creating terminal '${name}' failed: ${error && error.message ? error.message : error}`);
      },
    );
    return terminal;
  }

  const listen = (name) => (listener, thisArg, disposables) => {
    need('terminal');
    return track(host.events.on(name)(asExtension((data) => listener(data.terminal)), thisArg, disposables));
  };

  return {
    createTerminal,
    get terminals() {
      return [...state.terminals.values()].filter((entry) => entry.extension === ext.id).map((entry) => entry.terminal);
    },
    get activeTerminal() {
      const entry = state.terminals.get(state.activeTerminalId);
      return entry?.ready && entry.extension === ext.id ? entry.terminal : undefined;
    },
    onDidChangeActiveTerminal(listener, thisArg, disposables) {
      need('terminal');
      const current = () => { const entry = state.terminals.get(state.activeTerminalId); return entry?.ready && entry.extension === ext.id ? entry.terminal : undefined; };
      let previous = current();
      return track(host.events.on('activeTerminal')(asExtension(() => {
        const value = current(); if (value === previous) return; previous = value;
        listener.call(thisArg, value);
      }), undefined, disposables));
    },
    onDidChangeTerminalState(listener, thisArg, disposables) {
      need('terminal');
      return track(host.events.on('terminalState')(asExtension(data => {
        if (data.extension === ext.id) listener.call(thisArg, data.terminal);
      }), undefined, disposables));
    },
    onDidOpenTerminal: listen('terminalOpened'),
    onDidCloseTerminal: listen('terminalClosed'),
    EventEmitter,
  };
}

/** `host/terminalClosed`: the user closed a terminal an extension created (or its shell exited). */
function terminalClosed(host, params) {
  const entry = host.state.terminals && host.state.terminals.get(params.id);
  if (entry) entry.closed(typeof params.exitCode === 'number' ? params.exitCode : undefined);
}

function activeTerminalChanged(host, params) {
  if (params.id !== null && typeof params.id !== 'string') return;
  if (host.state.activeTerminalId === params.id) return;
  host.state.activeTerminalId = params.id;
  host.events.fire('activeTerminal', {});
}
function terminalStateChanged(host, params) {
  if (params.isInteractedWith === true) host.state.terminals?.get(params.id)?.stateChanged();
}
module.exports = { createTerminalApi, terminalClosed, activeTerminalChanged, terminalStateChanged };

