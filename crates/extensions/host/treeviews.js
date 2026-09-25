'use strict';
// Tree views for OpenMind Studio's extension host: `window.registerTreeDataProvider`, `window.createTreeView`,
// `TreeItem`, `TreeItemCollapsibleState` and `ThemeIcon` (a VS Code API subset, written for this app). The app
// draws the tree; it asks the host for children (`host/tree` op "children") and reports clicks and expand/collapse.
// Elements stay in the host: the app only ever sees opaque handles.

const path = require('path');

const TreeItemCollapsibleState = Object.freeze({ None: 0, Collapsed: 1, Expanded: 2 });

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
ThemeIcon.File = new ThemeIcon('file');
ThemeIcon.Folder = new ThemeIcon('folder');

class TreeItem {
  constructor(labelOrUri, collapsibleState = TreeItemCollapsibleState.None) {
    if (labelOrUri && typeof labelOrUri === 'object' && typeof labelOrUri.fsPath === 'string') {
      this.resourceUri = labelOrUri;
    } else {
      this.label = labelOrUri;
    }
    this.collapsibleState = collapsibleState;
  }
}

function labelOf(item) {
  const label = item.label;
  if (typeof label === 'string') return label;
  if (label && typeof label.label === 'string') return label.label;
  if (item.resourceUri && item.resourceUri.fsPath) return path.basename(item.resourceUri.fsPath);
  return '';
}

function plainText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.value === 'string') return value.value; // MarkdownString
  return undefined;
}

/** A tree item's icon as the app can draw it: a product icon name, or a file inside the extension. */
function iconOf(item, extensionPath) {
  let icon = item.iconPath;
  if (!icon) return item.resourceUri ? { theme: item.collapsibleState ? 'folder' : 'file' } : null;
  if (icon instanceof ThemeIcon || (typeof icon === 'object' && typeof icon.id === 'string' && !icon.fsPath)) {
    return { theme: icon.id };
  }
  if (icon && typeof icon === 'object' && !icon.fsPath && (icon.dark || icon.light)) icon = icon.dark || icon.light;
  const file = typeof icon === 'string' ? icon : icon && icon.fsPath;
  if (!file) return null;
  const relative = path.relative(extensionPath, path.resolve(extensionPath, file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return { file: relative.replace(/\\/g, '/') };
}

/** The `vscode.window` members and classes an extension gets, bound to that extension. */
function createTreeApi({ host, ext, track, executeCommand, Disposable, EventEmitter }) {
  const { state, notify } = host;
  if (!state.trees) state.trees = new Map();

  function register(viewId, provider, options = {}) {
    if (!provider || typeof provider.getChildren !== 'function' || typeof provider.getTreeItem !== 'function') {
      throw new Error('A tree data provider needs getChildren and getTreeItem.');
    }
    const existing = state.trees.get(viewId);
    if (existing) {
      throw new Error(
        existing.extension === ext.id
          ? `A data provider is already registered for view '${viewId}'.`
          : `View '${viewId}' belongs to ${existing.extension}.`,
      );
    }
    const selection = new EventEmitter();
    const expanded = new EventEmitter();
    const collapsed = new EventEmitter();
    const visibility = new EventEmitter();
    const tree = {
      extension: ext.id,
      extensionPath: ext.path,
      provider,
      handles: new Map(), // handle -> element
      elements: new Map(), // element (or item id) -> handle
      items: new Map(), // handle -> TreeItem (for its command)
      counter: 0,
      emitters: { selection, expanded, collapsed, visibility },
      execute: executeCommand,
    };
    state.trees.set(viewId, tree);
    let changeSubscription = null;
    if (typeof provider.onDidChangeTreeData === 'function') {
      changeSubscription = provider.onDidChangeTreeData((element) => {
        const list = Array.isArray(element) ? element : [element];
        for (const one of list) {
          const handle = one === undefined || one === null ? null : tree.elements.get(one) || null;
          notify('views/changed', { view: viewId, handle });
        }
      });
    }
    notify('views/registered', { view: viewId, extension: ext.id, showCollapseAll: !!options.showCollapseAll });
    let message;
    let title;
    let description;
    const view = {
      get visible() {
        return true;
      },
      get selection() {
        return [];
      },
      get message() {
        return message;
      },
      set message(value) {
        message = value;
        notify('views/message', { view: viewId, message: plainText(value) || null });
      },
      get title() {
        return title;
      },
      set title(value) {
        title = value;
        notify('views/title', { view: viewId, title: value || null, description: description || null });
      },
      get description() {
        return description;
      },
      set description(value) {
        description = value;
        notify('views/title', { view: viewId, title: title || null, description: value || null });
      },
      badge: undefined,
      onDidChangeSelection: selection.event,
      onDidExpandElement: expanded.event,
      onDidCollapseElement: collapsed.event,
      onDidChangeVisibility: visibility.event,
      onDidChangeCheckboxState: new EventEmitter().event,
      async reveal() {
        // Revealing an element isn't supported yet; the call succeeds without moving the tree.
      },
      dispose: () => disposable.dispose(),
    };
    const disposable = track(
      new Disposable(() => {
        if (state.trees.get(viewId) !== tree) return;
        state.trees.delete(viewId);
        if (changeSubscription && typeof changeSubscription.dispose === 'function') changeSubscription.dispose();
        notify('views/unregistered', { view: viewId });
      }),
    );
    tree.view = view;
    return { view, disposable };
  }

  return {
    registerTreeDataProvider(viewId, provider) {
      return register(viewId, provider).disposable;
    },
    createTreeView(viewId, options = {}) {
      if (!options.treeDataProvider) throw new Error('createTreeView needs options.treeDataProvider.');
      return register(viewId, options.treeDataProvider, options).view;
    },
  };
}

function handleOf(tree, element, item) {
  const key = item && typeof item.id === 'string' ? `id:${item.id}` : element;
  let handle = tree.elements.get(key);
  if (!handle) {
    tree.counter += 1;
    handle = `h${tree.counter}`;
    tree.elements.set(key, handle);
    if (key !== element) tree.elements.set(element, handle);
  }
  tree.handles.set(handle, element);
  return handle;
}

async function children(tree, parentHandle) {
  const parent = parentHandle ? tree.handles.get(parentHandle) : undefined;
  if (parentHandle && parent === undefined) throw new Error('That tree item is gone; refresh the view.');
  const elements = (await tree.provider.getChildren(parent)) || [];
  const out = [];
  for (const element of elements) {
    const item = await tree.provider.getTreeItem(element);
    if (!item) continue;
    const handle = handleOf(tree, element, item);
    tree.items.set(handle, item);
    const description = item.description === true && item.resourceUri ? item.resourceUri.fsPath : item.description;
    out.push({
      handle,
      label: labelOf(item),
      description: typeof description === 'string' ? description : null,
      tooltip: plainText(item.tooltip) || null,
      collapsible: item.collapsibleState || 0,
      icon: iconOf(item, tree.extensionPath),
      hasCommand: !!(item.command && item.command.command),
    });
  }
  return out;
}

/** `host/tree`: children of an item (or the roots), a click, or an expand/collapse. */
async function handleTreeRequest(state, params) {
  const tree = state.trees && state.trees.get(params.view);
  if (!tree) throw new Error(`No data provider is registered for view '${params.view}'.`);
  switch (params.op) {
    case 'children':
      return children(tree, params.handle || null);
    case 'click': {
      const element = tree.handles.get(params.handle);
      tree.emitters.selection.fire({ selection: element === undefined ? [] : [element] });
      const item = tree.items.get(params.handle);
      if (!item || !item.command || !item.command.command) return { ran: false };
      await tree.execute(item.command.command, ...(item.command.arguments || []));
      return { ran: true };
    }
    case 'expand':
    case 'collapse': {
      const element = tree.handles.get(params.handle);
      if (element !== undefined) {
        (params.op === 'expand' ? tree.emitters.expanded : tree.emitters.collapsed).fire({ element });
      }
      return { ok: true };
    }
    default:
      throw new Error(`Unknown tree operation '${params.op}'.`);
  }
}

module.exports = { createTreeApi, handleTreeRequest, TreeItem, TreeItemCollapsibleState, ThemeIcon };
