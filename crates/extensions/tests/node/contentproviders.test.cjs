'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./rpc-fixture.cjs');
const command = (host, name, ...args) => host.request('host/executeCommand', { command: name, args });
async function until(get, predicate) {
  const start = Date.now();
  while (Date.now() - start < 2000) { const value = await get(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Virtual document update did not arrive.');
}

test('content providers coalesce opens, refresh read-only text and forward updates without reopening editors', async t => {
  const host = await fixture(t, { 'test.content': { permissions: ['commands', 'workspaceRead', 'workspaceWrite'], code: `
    const v = require('vscode'); const changed = new v.EventEmitter(); let text = 'initial', reads = 0, opened = 0, modified = 0, lastChanges = [];
    const uri = v.Uri.parse('generated:/preview.js?query=keep#fragment'); let registration;
    exports.activate = () => {
      registration = v.workspace.registerTextDocumentContentProvider('generated', { onDidChange: changed.event,
        async provideTextDocumentContent(value) { reads++; if (value.query !== 'query=keep' || value.fragment !== 'fragment') throw Error('URI was changed'); await new Promise(resolve => setTimeout(resolve, 5)); return text; }
      });
      v.workspace.onDidOpenTextDocument(() => opened++); v.workspace.onDidChangeTextDocument(event => { modified++; lastChanges = event.contentChanges; });
      v.commands.registerCommand('content.open', async () => { const [a,b] = await Promise.all([v.workspace.openTextDocument(uri),v.workspace.openTextDocument(uri)]); return { same: a === b, text: a.getText(), reads, opened, version: a.version, language: a.languageId, saved: await a.save() }; });
      v.commands.registerCommand('content.update', value => { text = value; changed.fire(uri); });
      v.commands.registerCommand('content.state', () => { const doc = v.workspace.textDocuments.find(value => value.uri.toString() === uri.toString()); return { text: doc.getText(), version: doc.version, modified, lastChanges }; });
      v.commands.registerCommand('content.dispose', () => registration.dispose());
    };` } });
  await host.request('host/activate', { id: 'test.content' });
  const value = await command(host, 'content.open'); assert.equal(value.same, true); assert.equal(value.reads, 1); assert.equal(value.opened, 1); assert.equal(value.text, 'initial'); assert.equal(value.language, 'javascript'); assert.equal(value.saved, false);
  await command(host, 'content.update', 'updated');
  await until(() => command(host, 'content.state'), value => value.text === 'updated');
  const state = await command(host, 'content.state'); assert.equal(state.version, 2); assert.equal(state.modified, 1);
  assert.equal(state.lastChanges[0].rangeOffset, 0); assert.equal(state.lastChanges[0].rangeLength, 7); assert.equal(state.lastChanges[0].text, 'updated');
  const notifications = host.messages.filter(value => value.method === 'workspace/virtualDocumentChanged');
  assert.equal(notifications.length, 1); assert.equal(notifications[0].params.readonly, true); assert.equal(notifications[0].params.text, 'updated');
  assert.equal(host.messages.some(value => value.method === 'ui/showVirtualDocument'), false);
  await command(host, 'content.dispose'); await command(host, 'content.update', 'must not replace');
  assert.equal((await command(host, 'content.state')).text, 'updated');
  await assert.rejects(command(host, 'content.open'), /No file system provider/);
});

test('provider changes cancel superseded reads and discard responses that ignore cancellation', async t => {
  const host = await fixture(t, { 'test.content': { permissions: ['commands', 'workspaceRead'], code: `
    const v = require('vscode'); const changed = new v.EventEmitter(); let count = 0, cancelled = 0; const pending = [];
    const uri = v.Uri.parse('race:/value.txt');
    exports.activate = () => {
      v.workspace.registerTextDocumentContentProvider('race', { onDidChange: changed.event, provideTextDocumentContent(value, token) {
        if (++count === 1) return 'initial'; token.onCancellationRequested(() => cancelled++);
        return new Promise(resolve => pending.push(resolve));
      } });
      v.commands.registerCommand('race.open', async () => { await v.workspace.openTextDocument(uri); });
      v.commands.registerCommand('race.change', () => changed.fire(uri));
      v.commands.registerCommand('race.resolve', (index, value) => pending[index](value));
      v.commands.registerCommand('race.state', () => ({ cancelled, count, text: v.workspace.textDocuments[0].getText() }));
    };` } });
  await host.request('host/activate', { id: 'test.content' }); await command(host, 'race.open');
  await command(host, 'race.change'); await command(host, 'race.change');
  await command(host, 'race.resolve', 1, 'latest');
  await until(() => command(host, 'race.state'), value => value.text === 'latest');
  await command(host, 'race.resolve', 0, 'obsolete');
  const value = await command(host, 'race.state'); assert.equal(value.text, 'latest'); assert.equal(value.cancelled, 1);
});

test('deactivation settles pending content opens even if a provider ignores its token', async t => {
  const host = await fixture(t, { 'test.content': { permissions: ['commands', 'workspaceRead'], code: `
    const v = require('vscode'); exports.activate = () => {
      v.workspace.registerTextDocumentContentProvider('never', { provideTextDocumentContent: () => new Promise(() => {}) });
      v.commands.registerCommand('never.open', () => v.workspace.openTextDocument(v.Uri.parse('never:/value')));
    };` } });
  await host.request('host/activate', { id: 'test.content' });
  const opening = command(host, 'never.open'); const rejected = assert.rejects(opening, /cancelled|unavailable/);
  await host.request('host/deactivate', { id: 'test.content' }); await rejected;
});

test('content callbacks retain provider-owner permissions across extension boundaries', async t => {
  const host = await fixture(t, {
    'test.owner': { permissions: ['workspaceRead'], code: `const v = require('vscode'); exports.activate = () => v.workspace.registerTextDocumentContentProvider('owned', { provideTextDocumentContent() { try { require('net'); return 'allowed'; } catch(error) { return error.code; } } });` },
    'test.reader': { permissions: ['commands', 'workspaceRead', 'network'], code: `const v = require('vscode'); exports.activate = () => v.commands.registerCommand('owned.read', async () => (await v.workspace.openTextDocument(v.Uri.parse('owned:/value'))).getText());` }
  });
  await host.request('host/activate', { id: 'test.owner' }); await host.request('host/activate', { id: 'test.reader' });
  assert.equal(await command(host, 'owned.read'), 'EPERMISSION');
});

test('closing a content document cancels an active refresh and releases its host mirror', async t => {
  const host = await fixture(t, { 'test.content': { permissions: ['commands', 'workspaceRead'], code: `
    const v = require('vscode'); const changes = new v.EventEmitter(); const uri = v.Uri.parse('close:/value'); let reads = 0, cancellations = 0;
    exports.activate = () => {
      v.workspace.registerTextDocumentContentProvider('close', { onDidChange: changes.event, provideTextDocumentContent(value, token) {
        if (++reads === 1) return 'initial'; token.onCancellationRequested(() => cancellations++); return new Promise(() => {});
      } });
      v.commands.registerCommand('close.open', async () => (await v.workspace.openTextDocument(uri)).uri.toString());
      v.commands.registerCommand('close.change', () => changes.fire(uri));
      v.commands.registerCommand('close.state', () => ({ reads, cancellations, documents: v.workspace.textDocuments.length }));
    };` } });
  await host.request('host/activate', { id: 'test.content' }); const uri = await command(host, 'close.open');
  await command(host, 'close.change'); host.notify('host/documentClosed', { path: uri });
  await command(host, 'close.change'); const state = await command(host, 'close.state');
  assert.equal(state.reads, 2); assert.equal(state.cancellations, 1); assert.equal(state.documents, 0);
});

test('replacing a disposed provider cannot reuse its pending open or restore stale content', async t => {
  const host = await fixture(t, { 'test.content': { permissions: ['commands', 'workspaceRead'], code: `
    const v = require('vscode'); const uri = v.Uri.parse('replace:/value'); let registration, release;
    exports.activate = () => {
      registration = v.workspace.registerTextDocumentContentProvider('replace', { provideTextDocumentContent: () => new Promise(resolve => { release = resolve; }) });
      v.commands.registerCommand('replace.open', async () => (await v.workspace.openTextDocument(uri)).getText());
      v.commands.registerCommand('replace.provider', () => { registration.dispose(); registration = v.workspace.registerTextDocumentContentProvider('replace', { provideTextDocumentContent: () => 'replacement' }); });
      v.commands.registerCommand('replace.releaseOld', () => release('stale response'));
    };` } });
  await host.request('host/activate', { id: 'test.content' });
  const first = command(host, 'replace.open'); const rejection = assert.rejects(first, /cancelled|unavailable/);
  await command(host, 'replace.provider');
  assert.equal(await command(host, 'replace.open'), 'replacement'); await rejection;
  await command(host, 'replace.releaseOld'); assert.equal(await command(host, 'replace.open'), 'replacement');
});


test('failed provider registration leaves restored document ownership unchanged', () => {
  const { create } = require('../../host/contentproviders.js');
  const data = { path: 'restored:///value', native: true, virtual: true, readonly: true, contentProvider: 'previous-owner' };
  const state = { documents: new Map([[data.path, data]]) };
  const host = { state, als: { run: (_owner, callback) => callback() } };
  class Disposable { constructor(callback) { this.dispose = callback; } }
  const api = create({ host, ext: { id: 'test.owner' }, need() {}, track: value => value, Disposable, editors: {}, guessLanguage() {} });
  assert.throws(() => api.register('restored', {
    provideTextDocumentContent: () => 'unused',
    onDidChange() { throw Error('subscription failed'); },
  }), /subscription failed/);
  assert.equal(data.contentProvider, 'previous-owner');
  assert.equal(state.textContentProviders.has('restored'), false);
  const registration = api.register('restored', { provideTextDocumentContent: () => 'unused' });
  assert.notEqual(data.contentProvider, 'previous-owner');
  assert.equal(data.contentProvider, state.textContentProviders.get('restored').id);
  registration.dispose();
});
