'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./api-fixture.cjs');
const { disposeApi } = require('../../host/vscode.js');
const enums = require('./vscode-1.85-enums.json');

test('all exported numeric enums match official VS Code 1.85 declarations', () => {
  const { api } = fixture();
  for (const [name, expected] of Object.entries(enums.values)) {
    assert.ok(Object.hasOwn(api, name), `${name} missing`);
    const runtime = { ...expected };
    for (const [key, value] of Object.entries(expected)) runtime[value] = key;
    assert.deepEqual(api[name], runtime, name);
  }
  disposeApi(api);
});

test('commands preserve thisArg, result, duplicate ownership and disposal', async () => {
  const { host, api } = fixture(['commands']);
  const subscription = api.commands.registerCommand('test.sum', function (value) { return this.base + value; }, { base: 10 });
  assert.equal(await api.commands.executeCommand('test.sum', 5), 15);
  assert.equal(await host.state.commands.get('test.sum').callback(2), 12);
  assert.throws(() => api.commands.registerCommand('test.sum', () => {}), /already registered/);
  assert.throws(() => api.commands.registerCommand('bad', undefined), TypeError);
  subscription.dispose();
  assert.equal(host.state.commands.has('test.sum'), false);
  disposeApi(api);
});

test('workspace paths choose the deepest root and honor includeWorkspaceFolder', () => {
  const { host, api } = fixture();
  const root = path.resolve('test-workspace');
  const nested = path.join(root, 'nested');
  host.state.workspaceFolders = [{ path: root, name: 'Project' }, { path: nested, name: 'Nested' }];
  const uri = api.Uri.file(path.join(nested, 'src/file.js'));
  assert.equal(api.workspace.getWorkspaceFolder(uri).index, 1);
  assert.equal(api.workspace.asRelativePath(uri), 'Nested/src/file.js');
  assert.equal(api.workspace.asRelativePath(uri, false), 'src/file.js');
  assert.equal(api.workspace.asRelativePath(api.Uri.file(nested), false), '');
  assert.equal(api.workspace.getWorkspaceFolder(api.Uri.file(root + '-other/file.js')), undefined);
  assert.equal(api.workspace.getWorkspaceFolder(api.Uri.parse('memory:/src/file.js')), undefined);
  host.state.workspaceFolders.pop();
  assert.equal(api.workspace.asRelativePath(uri), 'nested/src/file.js');
  assert.equal(api.workspace.asRelativePath(uri, true), 'Project/nested/src/file.js');
  disposeApi(api);
});

test('cancellation propagates from a parent and notifies late listeners asynchronously', async () => {
  const { api } = fixture();
  const parent = new api.CancellationTokenSource();
  const child = new api.CancellationTokenSource(parent.token);
  parent.cancel();
  assert.equal(child.token.isCancellationRequested, true);
  let called = false;
  child.token.onCancellationRequested(() => { called = true; });
  assert.equal(called, false);
  await Promise.resolve();
  assert.equal(called, true);
  child.dispose();
  parent.dispose();
  disposeApi(api);
});

test('disposing a late cancellation subscription prevents its callback', async () => {
  const { api } = fixture();
  const source = new api.CancellationTokenSource();
  source.cancel();
  let called = false;
  source.token.onCancellationRequested(() => { called = true; }).dispose();
  await Promise.resolve();
  assert.equal(called, false);
  source.dispose();
  disposeApi(api);
});
