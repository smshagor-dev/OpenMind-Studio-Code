'use strict';
// Webview panels for OpenMind Studio's extension host: `window.createWebviewPanel` and the `Webview` object (a
// VS Code API subset, written for this app). The application draws a panel inside a sandboxed iframe and owns
// everything security-relevant (what the HTML may load, scripts, local files); this module only keeps the
// extension-side objects and sends `webview/*` notifications. See `src/services/webviewService.ts` and
// `webviewHtml.ts` for the other half. Not supported (they throw the "not supported" message): command URIs,
// port mapping, panel serializers, webview views, and remote content.

const path = require('path');
const { within } = require('./guard.js');

const RESOURCE_SCHEME = 'openmind-webview-resource';
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

let counter = 0;

function unsupportedMessage(name) {
  return `VS Code API '${name}' is not supported by OpenMind Studio yet.`;
}

function base64url(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createWebviewApi({ host, ext, need, track, Disposable, EventEmitter, Uri, namespace, asExtension }) {
  const { notify, state } = host;
  const granted = new Set(ext.permissions || []);

  /** "Permission 'x' is required for this webview resource." — the message the spec asks for. */
  function resourcePermission(permission) {
    const error = new Error(`Permission '${permission}' is required for this webview resource.`);
    error.code = 'EPERMISSION';
    return error;
  }

  /** The absolute local resource roots of a webview: its own folder by default, others only with their permission. */
  function rootsOf(options) {
    const given = options && options.localResourceRoots;
    if (given === undefined) return [path.resolve(ext.path)];
    if (!Array.isArray(given)) throw new Error('localResourceRoots must be a list of Uris.');
    return given.map((uri) => {
      const root = path.resolve(uri && uri.fsPath ? uri.fsPath : String(uri));
      if (within(ext.path, root)) return root;
      if (state.workspaceFolders.some((folder) => within(folder.path, root))) {
        if (!granted.has('workspaceRead') && !granted.has('filesystemOutsideWorkspace')) throw resourcePermission('workspaceRead');
        return root;
      }
      if (!granted.has('filesystemOutsideWorkspace')) throw resourcePermission('filesystemOutsideWorkspace');
      return root;
    });
  }

  function checkOptions(options) {
    const o = options || {};
    if (o.enableCommandUris) throw new Error(unsupportedMessage('WebviewOptions.enableCommandUris'));
    if (Array.isArray(o.portMapping) && o.portMapping.length > 0) throw new Error(unsupportedMessage('WebviewOptions.portMapping'));
    return {
      enableScripts: o.enableScripts === true,
      // Forms have nowhere to go (the sandbox has no form submission), so this only records what was asked.
      enableForms: o.enableForms === true,
      retainContextWhenHidden: o.retainContextWhenHidden === true,
      roots: rootsOf(o),
      localResourceRoots: o.localResourceRoots,
    };
  }

  function createWebviewPanel(viewType, title, showOptions, options) {
    if (typeof viewType !== 'string' || viewType === '') throw new Error('createWebviewPanel needs a view type.');
    counter += 1;
    const id = `${ext.id}#wv-${counter}`;
    let current = checkOptions(options);
    let currentTitle = String(title === undefined ? '' : title);
    let html = '';
    let disposed = false;
    let visible = true;
    let active = true;
    const column = typeof showOptions === 'number' ? showOptions : (showOptions && showOptions.viewColumn) || 1;
    const messages = new EventEmitter();
    const disposedEvents = new EventEmitter();
    const viewState = new EventEmitter();
    const alive = () => {
      if (disposed) throw new Error('Webview is disposed');
    };

    const webview = namespace('Webview', {
      get html() {
        return html;
      },
      set html(value) {
        alive();
        const text = String(value === undefined || value === null ? '' : value);
        if (Buffer.byteLength(text, 'utf8') > MAX_HTML_BYTES) throw new Error('The webview HTML is larger than 5 MB.');
        html = text;
        notify('webview/html', { extension: ext.id, id, html });
      },
      get options() {
        return { enableScripts: current.enableScripts, enableForms: current.enableForms, localResourceRoots: current.localResourceRoots };
      },
      set options(value) {
        alive();
        current = { ...checkOptions(value), retainContextWhenHidden: current.retainContextWhenHidden };
        notify('webview/options', { extension: ext.id, id, enableScripts: current.enableScripts, roots: current.roots });
      },
      cspSource: `${RESOURCE_SCHEME}:`,
      postMessage(message) {
        if (disposed) return Promise.resolve(false);
        let json;
        try {
          json = JSON.stringify(message);
        } catch (error) {
          return Promise.reject(new Error(`A webview message must be JSON-serializable: ${error.message}`));
        }
        if (json === undefined) return Promise.reject(new Error('A webview message must be JSON-serializable data, not a function or undefined.'));
        if (Buffer.byteLength(json, 'utf8') > MAX_MESSAGE_BYTES) return Promise.reject(new Error('The webview message is larger than 1 MB.'));
        notify('webview/postMessage', { extension: ext.id, id, message: json });
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener, thisArg, disposables) => messages.event(asExtension(listener), thisArg, disposables),
      asWebviewUri(uri) {
        alive();
        const file = path.resolve(uri && uri.fsPath ? uri.fsPath : String(uri));
        if (uri && uri.scheme && uri.scheme !== 'file') throw new Error(`Only file: Uris can be used in a webview, not ${uri.scheme}:.`);
        if (!current.roots.some((root) => within(root, file))) {
          throw new Error(`The file is outside this webview's localResourceRoots: ${file}`);
        }
        return Uri.parse(`${RESOURCE_SCHEME}://panel/${base64url(file)}`);
      },
    });

    const panel = namespace('WebviewPanel', {
      viewType,
      get title() {
        return currentTitle;
      },
      set title(value) {
        alive();
        currentTitle = String(value);
        notify('webview/title', { extension: ext.id, id, title: currentTitle });
      },
      iconPath: undefined,
      get webview() {
        return webview;
      },
      get options() {
        return { retainContextWhenHidden: current.retainContextWhenHidden };
      },
      get viewColumn() {
        return column;
      },
      get active() {
        return active;
      },
      get visible() {
        return visible;
      },
      reveal() {
        alive();
        notify('webview/reveal', { extension: ext.id, id });
      },
      onDidDispose: disposedEvents.event,
      onDidChangeViewState: viewState.event,
      dispose() {
        finish(true);
      },
    });

    const listeners = [
      host.events.on('webviewMessage')((data) => {
        if (data.id !== id || disposed) return;
        let value;
        try {
          value = JSON.parse(data.message);
        } catch {
          return;
        }
        messages.fire(value);
      }),
      host.events.on('webviewDisposed')((data) => {
        if (data.id === id) finish(false);
      }),
      host.events.on('webviewViewState')((data) => {
        if (data.id !== id || disposed) return;
        visible = data.visible !== false;
        active = data.active === true;
        viewState.fire({ webviewPanel: panel });
      }),
    ];

    /** `tellApp`: the extension closed it; otherwise the user did and the app already knows. */
    function finish(tellApp) {
      if (disposed) return;
      disposed = true;
      for (const listener of listeners) listener.dispose();
      if (tellApp) notify('webview/dispose', { extension: ext.id, id });
      disposedEvents.fire();
      messages.dispose();
      disposedEvents.dispose();
      viewState.dispose();
    }

    track(new Disposable(() => finish(true)));
    notify('webview/create', {
      extension: ext.id,
      id,
      viewType,
      title: currentTitle,
      enableScripts: current.enableScripts,
      retain: current.retainContextWhenHidden,
      roots: current.roots,
      viewColumn: column,
      preserveFocus: !!(showOptions && showOptions.preserveFocus),
    });
    return panel;
  }

  return { createWebviewPanel, need };
}

module.exports = { createWebviewApi, RESOURCE_SCHEME };
