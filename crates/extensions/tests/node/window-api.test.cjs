'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./rpc-fixture.cjs');

test('active color theme follows initialization and live events without erasing configuration', async t => {
  const host = await fixture(t, { 'test.theme': { permissions: ['commands', 'settings'], code: `const v = require('vscode'); let seen = []; const target = { count: 0 };
    exports.activate = context => {
      context.subscriptions.push(v.window.onDidChangeActiveColorTheme(function(theme) { this.count++; seen.push(theme.kind); }, target));
      v.commands.registerCommand('theme.read', () => ({ kind: v.window.activeColorTheme.kind, seen, count: target.count, configured: v.workspace.getConfiguration('example').get('enabled'), uiKind: v.env.uiKind, remote: v.env.remoteName === undefined }));
    };` } });
  await host.request('host/init', { colorTheme: 'light', configuration: { 'example.enabled': true } });
  await host.request('host/activate', { id: 'test.theme' });
  assert.deepEqual(await host.request('host/executeCommand', { command: 'theme.read' }), { kind: 1, seen: [], count: 0, configured: true, uiKind: 1, remote: true });
  host.notify('host/configurationChanged', { colorTheme: 'high-contrast' });
  host.notify('host/configurationChanged', { colorTheme: 'high-contrast' });
  assert.deepEqual(await host.request('host/executeCommand', { command: 'theme.read' }), { kind: 3, seen: [3], count: 1, configured: true, uiKind: 1, remote: true });
});

test('a contributed setting the app has no value for reads its package.json default, like VS Code', async t => {
  const manifest = { name: 'csv', publisher: 'test', version: '1.0.0', main: 'extension.js', contributes: { configuration: {
    properties: { 'csv.separators': { type: 'array', default: ['TAB', ','] }, 'csv.limits': { type: 'object', default: { rows: 5 } }, 'csv.enabled': { type: 'boolean', default: true } } } } };
  const host = await fixture(t, { 'test.csv': { permissions: ['commands', 'settings'], files: { 'package.json': JSON.stringify(manifest) }, code: `const v = require('vscode');
    exports.activate = () => v.commands.registerCommand('csv.read', () => { const c = v.workspace.getConfiguration('csv');
      return { separators: c.get('separators'), limits: c.get('limits'), enabled: c.get('enabled'), has: c.has('separators'), missing: c.get('nothing', 'fallback') }; });` } });
  await host.request('host/init', { configuration: { 'csv.enabled': false } });
  await host.request('host/activate', { id: 'test.csv' });
  assert.deepEqual(await host.request('host/executeCommand', { command: 'csv.read' }),
    { separators: ['TAB', ','], limits: { rows: 5 }, enabled: false, has: true, missing: 'fallback' });
});

test('a permission refused inside a command is reported to the app once, naming the extension', async t => {
  const host = await fixture(t, { 'test.denied': { permissions: ['commands'], code: `const v = require('vscode');
    exports.activate = () => v.commands.registerCommand('denied.read', () => v.workspace.getConfiguration('x'));` } });
  await host.request('host/init', {});
  await host.request('host/activate', { id: 'test.denied' });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(host.request('host/executeCommand', { command: 'denied.read' }), /Permission 'settings' is required/);
  }
  const reports = host.messages.filter(m => m.method === 'extensions/permissionDenied').map(m => m.params);
  assert.deepEqual(reports, [{ id: 'test.denied', permission: 'settings' }]);
});

test('status messages stack, restore previous entries, expire and clean up on extension teardown', async t => {
  const host = await fixture(t, { 'test.status': { permissions: ['commands'], code: `const v = require('vscode'); let first, second, finish;
    exports.activate = () => {
      v.commands.registerCommand('status.first', () => { first = v.window.setStatusBarMessage('first'); });
      v.commands.registerCommand('status.second', () => { second = v.window.setStatusBarMessage('second'); });
      v.commands.registerCommand('status.clearSecond', () => second.dispose());
      v.commands.registerCommand('status.promise', () => { v.window.setStatusBarMessage('promise', new Promise((resolve, reject) => { finish = reject; })); });
      v.commands.registerCommand('status.finish', () => finish(Error('finished')));
      v.commands.registerCommand('status.timer', async () => { v.window.setStatusBarMessage('timer', 5); await new Promise(resolve => setTimeout(resolve, 15)); });
      v.commands.registerCommand('status.barrier', () => true);
    };` } });
  await host.request('host/activate', { id: 'test.status' });
  const command = name => host.request('host/executeCommand', { command: 'status.' + name });
  const visible = () => {
    const items = new Map();
    for (const message of host.messages) {
      if (message.method === 'statusBar/set') items.set(message.params.id, message.params);
      if (message.method === 'statusBar/dispose') items.delete(message.params.id);
    }
    return [...items.values()].filter(item => item.visible).map(item => item.text);
  };
  await command('first'); assert.deepEqual(visible(), ['first']);
  await command('second'); assert.deepEqual(visible(), ['second']);
  await command('clearSecond'); assert.deepEqual(visible(), ['first']);
  await command('promise'); assert.deepEqual(visible(), ['promise']);
  await command('finish'); await command('barrier'); assert.deepEqual(visible(), ['first']);
  await command('timer'); assert.deepEqual(visible(), ['first']);
  await host.request('host/deactivate', { id: 'test.status' }); assert.deepEqual(visible(), []);
});

test('accepted inline commands and result release remain valid after the source document closes', async t => {
  const host = await fixture(t, { 'test.inline': { permissions: ['commands', 'languages'], code: `const v = require('vscode'); exports.activate = () => {
    v.commands.registerCommand('inline.accepted', value => value.get('answer'));
    v.languages.registerInlineCompletionItemProvider('javascript', { provideInlineCompletionItems() { return [new v.InlineCompletionItem(new v.SnippetString('value($1)'), new v.Range(0,0,0,3), { command: 'inline.accepted', title: 'Accepted', arguments: [new Map([['answer',42]])] })]; } });
  };` } });
  const file = '/inline-virtual-test.js';
  await host.request('host/init', { documents: [{ path: file, text: 'val', languageId: 'javascript', version: 1 }] });
  await host.request('host/activate', { id: 'test.inline' });
  const handle = host.messages.find(message => message.method === 'languages/registered').params.handle;
  const provide = params => host.request('host/provide', { handle, path: file, ...params });
  const [item] = await provide({ position: { line: 0, character: 3 } });
  assert.deepEqual(item.insertText, { snippet: 'value($1)' });
  host.notify('host/documentClosed', { path: file });
  assert.equal(await provide({ action: 'command', itemId: item.id }), 42);
  await provide({ action: 'release', itemIds: [item.id] });
  await assert.rejects(provide({ action: 'command', itemId: item.id }), /no longer available/);
});
