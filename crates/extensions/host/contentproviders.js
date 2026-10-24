'use strict';
const { randomUUID } = require('crypto');

function create({ host, ext, need, track, Disposable, editors, guessLanguage }) {
  const { state } = host;
  state.textContentProviders ||= new Map();
  state.contentDocumentOpens ||= new Map();
  const owned = (entry, callback) => host.als.run(entry.extension, callback);
  const { CancellationTokenSource } = require('./vscode.js');

  async function read(entry, uri) {
    const key = uri.toString();
    const previous = entry.requests.get(key);
    if (previous) owned(entry, () => previous.cancel());
    const source = new CancellationTokenSource(); entry.requests.set(key, source);
    let cancellation;
    try {
      const cancelled = new Promise((_, reject) => { cancellation = source.token.onCancellationRequested(() => reject(new Error('Virtual document request was cancelled.'))); });
      const text = await Promise.race([owned(entry, () => entry.provider.provideTextDocumentContent(uri, source.token)), cancelled]);
      if (!entry.active || source.token.isCancellationRequested) throw new Error('The virtual document provider is unavailable.');
      if (typeof text !== 'string') throw new Error('A text document content provider must return a string.');
      if (Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw new Error('Virtual document content exceeds 32 MB.');
      return text;
    } finally {
      cancellation?.dispose(); source.dispose();
      if (entry.requests.get(key) === source) entry.requests.delete(key);
    }
  }
  async function refresh(entry, uri) {
    if (!entry.active || uri?.scheme !== entry.scheme) return;
    const key = uri.toString(), data = state.documents.get(key);
    if (!data || data.contentProvider !== entry.id) return;
    const revision = (entry.revisions.get(key) || 0) + 1; entry.revisions.set(key, revision);
    try {
      const text = await read(entry, uri);
      if (!entry.active || entry.revisions.get(key) !== revision || state.documents.get(key) !== data || text === data.text) return;
      if (data.native) {
        host.notify('workspace/virtualDocumentChanged', { extension: entry.extension, uri: key, scheme: uri.scheme, path: uri.path, text, languageId: data.languageId, readonly: true });
        return;
      }
      const previous = data.text; const end = editors.document(data).positionAt(previous.length);
      data.text = text; data.version++;
      host.events.fire('documentChanged', { ...data, contentChanges: [{ range: new editors.Range(0, 0, end.line, end.character), rangeOffset: 0, rangeLength: previous.length, text }] });
      host.notify('workspace/virtualDocumentChanged', { extension: entry.extension, uri: key, scheme: uri.scheme, path: uri.path,
        text, languageId: data.languageId, readonly: true, version: data.version });
    } catch (error) {
      if (entry.active && entry.revisions.get(key) === revision) host.log?.(entry.extension, 'error', `Refreshing virtual document failed: ${error.message}`);
    }
  }
  function register(scheme, provider) {
    need('workspaceRead');
    if (typeof scheme !== 'string' || !/^[a-z][a-z0-9+.-]*$/.test(scheme) || /^(file|untitled|vscode-notebook-cell)$/.test(scheme)) throw new Error('Invalid or reserved text document scheme.');
    if (state.textContentProviders.has(scheme)) throw new Error(`A text document content provider already owns '${scheme}:'.`);
    if (typeof provider?.provideTextDocumentContent !== 'function') throw new Error('A text document content provider needs provideTextDocumentContent().');
    const entry = { id: randomUUID(), extension: ext.id, scheme, provider, active: true, requests: new Map(), revisions: new Map() };
    state.textContentProviders.set(scheme, entry);
    let subscription;
    try {
      if (provider.onDidChange) subscription = owned(entry, () => provider.onDidChange(uri => { void owned(entry, () => refresh(entry, uri)); }));
    } catch (error) { entry.active = false; state.textContentProviders.delete(scheme); throw error; }
    // Adopt only after subscription succeeds so a failed registration cannot steal restored documents.
    for (const data of state.documents.values()) if (data.native && data.virtual && data.readonly && data.path.startsWith(scheme + '://')) data.contentProvider = entry.id;
    return track(new Disposable(() => owned(entry, () => {
      if (!entry.active) return;
      entry.active = false;
      if (state.textContentProviders.get(scheme) === entry) state.textContentProviders.delete(scheme);
      try { subscription?.dispose(); }
      finally { for (const source of entry.requests.values()) source.cancel(); entry.requests.clear(); entry.revisions.clear();
        for (const [key, pending] of state.contentDocumentOpens) if (pending.entry === entry) state.contentDocumentOpens.delete(key); }
    })));
  }
  async function open(uri) {
    need('workspaceRead');
    const key = uri.toString(), entry = state.textContentProviders.get(uri.scheme);
    if (!entry?.active) throw new Error(`No content provider for '${uri.scheme}:'.`);
    const existing = state.documents.get(key);
    if (existing?.contentProvider === entry.id) return editors.document(existing);
    if (state.contentDocumentOpens.get(key)?.entry !== entry) {
      const pending = read(entry, uri).then(text => {
        if (!entry.active || state.textContentProviders.get(uri.scheme) !== entry) throw new Error('The virtual document provider is unavailable.');
        const data = { path: key, text, languageId: guessLanguage(uri.path), version: existing ? existing.version + 1 : 1,
          isDirty: false, virtual: true, readonly: true, contentProvider: entry.id };
        state.documents.set(key, data); host.events.fire(existing ? 'documentChanged' : 'documentOpened', data); return data;
      }).finally(() => { if (state.contentDocumentOpens.get(key)?.promise === pending) state.contentDocumentOpens.delete(key); });
      state.contentDocumentOpens.set(key, { entry, promise: pending });
    }
    return editors.document(await state.contentDocumentOpens.get(key).promise);
  }
  return { register, open };
}
function close(host, data) {
  if (!data?.contentProvider) return;
  for (const entry of host.state.textContentProviders?.values() || []) if (entry.id === data.contentProvider) {
    entry.revisions.delete(data.path);
    const source = entry.requests.get(data.path);
    if (source) host.als.run(entry.extension, () => source.cancel());
    entry.requests.delete(data.path);
  }
}
module.exports = { create, close };
