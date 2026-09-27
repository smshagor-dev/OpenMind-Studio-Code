'use strict';
// Webviews for OpenMind Studio's extension host: `window.createWebviewPanel`, `window.registerWebviewViewProvider`
// (Milestone 18: webview views inside an extension's side bar container) and the `Webview` object (a VS Code API
// subset, written for this app). The application draws every webview inside a sandboxed iframe and owns everything
// security-relevant (what the HTML may load, scripts, local files); this module only keeps the extension-side
// objects and sends `webview/*` notifications. Panels and views share one core, so they share every rule. See
// `src/services/webviewService.ts` and `webviewHtml.ts` for the other half. Not supported (they throw the "not
// supported" message): command URIs, port mapping, panel serializers, and remote content.

const path = require('path');
const { within } = require('./guard.js');

const RESOURCE_SCHEME = 'openmind-webview-resource';
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

let counter = 0;

const { unsupportedError } = require('./unsupported.js');

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
    if (o.enableCommandUris) throw unsupportedError('WebviewOptions.enableCommandUris');
    if (Array.isArray(o.portMapping) && o.portMapping.length > 0) throw unsupportedError('WebviewOptions.portMapping');
    return {
      enableScripts: o.enableScripts === true,
      // Forms have nowhere to go (the sandbox has no form submission), so this only records what was asked.
      enableForms: o.enableForms === true,
      retainContextWhenHidden: o.retainContextWhenHidden === true,
      roots: rootsOf(o),
      localResourceRoots: o.localResourceRoots,
    };
  }

  /**
   * The part panels and views share: the `Webview` object, its messages and its life cycle. `announce` is sent with
   * `webview/create` (it says `placement: 'panel' | 'view'`).
   */
  function createCore(id, options, announce) {
    let current = checkOptions(options);
    let html = '';
    let disposed = false;
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
        if (uri && uri.scheme && uri.scheme !== 'file') throw new Error(`Only file: Uris can be used in a webview, not ${uri.scheme}:.`);
        const raw = uri && uri.fsPath ? uri.fsPath : String(uri);
        if (raw.includes(String.fromCharCode(0))) throw new Error('That is not a valid file path.');
        // Network paths (UNC, \\server\share) are never a local resource, whatever the roots say.
        if (raw.startsWith('\\') || raw.startsWith('//')) throw new Error(`Network paths can't be used in a webview: ${raw}`);
        const file = path.resolve(raw);
        if (!current.roots.some((root) => within(root, file))) {
          throw new Error(`The file is outside this webview's localResourceRoots: ${file}`);
        }
        return Uri.parse(`${RESOURCE_SCHEME}://panel/${base64url(file)}`);
      },
    });

    const listeners = [];
    const core = {
      webview,
      alive,
      get disposed() {
        return disposed;
      },
      retain: () => current.retainContextWhenHidden,
      onDidDispose: disposedEvents.event,
      onDidChangeViewState: viewState.event,
      /** `tellApp`: the extension closed it; otherwise the user (or the app) did and the app already knows. */
      finish(tellApp) {
        if (disposed) return;
        disposed = true;
        for (const listener of listeners) listener.dispose();
        if (tellApp) notify('webview/dispose', { extension: ext.id, id });
        disposedEvents.fire();
        messages.dispose();
        disposedEvents.dispose();
        viewState.dispose();
      },
    };

    listeners.push(
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
        if (data.id === id) core.finish(false);
      }),
      host.events.on('webviewViewState')((data) => {
        if (data.id !== id || disposed) return;
        viewState.fire(data);
      }),
    );

    track(new Disposable(() => core.finish(true)));
    notify('webview/create', {
      extension: ext.id,
      id,
      enableScripts: current.enableScripts,
      retain: current.retainContextWhenHidden,
      roots: current.roots,
      ...announce,
    });
    return core;
  }

  function createWebviewPanel(viewType, title, showOptions, options) {
    if (typeof viewType !== 'string' || viewType === '') throw new Error('createWebviewPanel needs a view type.');
    counter += 1;
    const id = `${ext.id}#wv-${counter}`;
    let currentTitle = String(title === undefined ? '' : title);
    let visible = true;
    let active = true;
    const column = typeof showOptions === 'number' ? showOptions : (showOptions && showOptions.viewColumn) || 1;
    const panelState = new EventEmitter();
    const core = createCore(id, options, {
      placement: 'panel',
      viewType,
      title: currentTitle,
      viewColumn: column,
      preserveFocus: !!(showOptions && showOptions.preserveFocus),
    });

    const panel = namespace('WebviewPanel', {
      viewType,
      get title() {
        return currentTitle;
      },
      set title(value) {
        core.alive();
        currentTitle = String(value);
        notify('webview/title', { extension: ext.id, id, title: currentTitle });
      },
      iconPath: undefined,
      get webview() {
        return core.webview;
      },
      get options() {
        return { retainContextWhenHidden: core.retain() };
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
        core.alive();
        notify('webview/reveal', { extension: ext.id, id });
      },
      onDidDispose: core.onDidDispose,
      onDidChangeViewState: panelState.event,
      dispose() {
        core.finish(true);
      },
    });
    core.onDidChangeViewState((data) => {
      visible = data.visible !== false;
      active = data.active === true;
      panelState.fire({ webviewPanel: panel });
    });
    core.onDidDispose(() => panelState.dispose());
    return panel;
  }

  /** The views this extension declared in `contributes.views` with `"type": "webview"`. */
  function contributedWebviewViews() {
    const views = (ext.manifest && ext.manifest.contributes && ext.manifest.contributes.views) || {};
    const ids = new Set();
    // The parsed manifest (what the app hands the host): containers with their views and each view's kind.
    for (const container of Array.isArray(views.containers) ? views.containers : []) {
      for (const view of container.views || []) if (view && view.kind === 'webview' && typeof view.id === 'string') ids.add(view.id);
    }
    // A raw `package.json` shape (`{ "<container>": [{ "id", "type" }] }`), as a fallback.
    for (const list of Object.values(views)) {
      if (!Array.isArray(list)) continue;
      for (const view of list) if (view && view.type === 'webview' && typeof view.id === 'string') ids.add(view.id);
    }
    return ids;
  }

  /** Builds the `WebviewView` object of a resolved view around its core. */
  function webviewViewObject(id, viewId, core) {
    let title;
    let description;
    let visible = true;
    const visibility = new EventEmitter();
    const view = namespace('WebviewView', {
      viewType: viewId,
      get webview() {
        return core.webview;
      },
      get title() {
        return title;
      },
      set title(value) {
        title = value === undefined ? undefined : String(value);
        notify('webview/title', { extension: ext.id, id, title: title || '' });
      },
      get description() {
        return description;
      },
      set description(value) {
        description = value === undefined ? undefined : String(value);
        notify('webview/description', { extension: ext.id, id, description: description || '' });
      },
      badge: undefined,
      get visible() {
        return visible;
      },
      show(preserveFocus) {
        core.alive();
        notify('webview/revealView', { extension: ext.id, id, view: viewId, preserveFocus: !!preserveFocus });
      },
      onDidDispose: core.onDidDispose,
      onDidChangeVisibility: visibility.event,
      dispose() {
        core.finish(true);
      },
    });
    core.onDidChangeViewState((data) => {
      const next = data.visible !== false;
      if (next === visible) return;
      visible = next;
      visibility.fire();
    });
    core.onDidDispose(() => visibility.dispose());
    return view;
  }

  /**
   * `window.registerWebviewViewProvider`: the view must be one of this extension's `"type": "webview"` views. The
   * provider's `resolveWebviewView` runs when the user first shows the view (the app asks with
   * `host/resolveWebviewView`), never before.
   */
  function registerWebviewViewProvider(viewId, provider, options) {
    if (typeof viewId !== 'string' || !contributedWebviewViews().has(viewId)) {
      throw new Error(`View '${viewId}' is not a webview view contributed by ${ext.id} (contributes.views with "type": "webview").`);
    }
    if (!provider || typeof provider.resolveWebviewView !== 'function') {
      throw new Error('registerWebviewViewProvider needs a provider with resolveWebviewView.');
    }
    if (!state.webviewViews) state.webviewViews = new Map();
    if (state.webviewViews.has(viewId)) throw new Error(`View '${viewId}' already has a webview view provider.`);
    const retain = !!(options && options.webviewOptions && options.webviewOptions.retainContextWhenHidden);
    let resolved = null;

    const entry = {
      extension: ext.id,
      /** Creates the view's webview (once) and lets the provider fill it. */
      async resolve() {
        if (resolved && !resolved.core.disposed) return { id: resolved.id };
        counter += 1;
        const id = `${ext.id}#wvv-${counter}`;
        const core = createCore(id, { enableScripts: false, retainContextWhenHidden: retain }, {
          placement: 'view',
          view: viewId,
          viewType: viewId,
          title: '',
        });
        const webviewView = webviewViewObject(id, viewId, core);
        core.onDidDispose(() => {
          if (resolved && resolved.id === id) resolved = null;
        });
        resolved = { id, core };
        const token = { isCancellationRequested: false, onCancellationRequested: () => new Disposable(() => {}) };
        await provider.resolveWebviewView(webviewView, { state: undefined }, token);
        return { id };
      },
    };
    state.webviewViews.set(viewId, entry);
    notify('webview/viewProvider', { extension: ext.id, view: viewId, registered: true });
    return track(
      new Disposable(() => {
        if (state.webviewViews.get(viewId) === entry) state.webviewViews.delete(viewId);
        if (resolved) resolved.core.finish(true);
        notify('webview/viewProvider', { extension: ext.id, view: viewId, registered: false });
      }),
    );
  }

  return { createWebviewPanel, registerWebviewViewProvider, need };
}

/** `host/resolveWebviewView`: the app shows view `params.view`; its provider (if one is registered) fills it. */
async function resolveWebviewView(host, params) {
  const entry = host.state.webviewViews && host.state.webviewViews.get(params.view);
  if (!entry) return { id: null };
  return host.als.run(entry.extension, () => entry.resolve());
}

module.exports = { createWebviewApi, resolveWebviewView, RESOURCE_SCHEME };
