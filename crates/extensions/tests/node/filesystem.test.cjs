'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createGuard, within } = require('../../host/guard.js');
const { createFileSystemApi } = require('../../host/fsprovider.js');
const { Uri, Disposable } = require('../../host/vscode.js');
const { fixture: apiFixture } = require('./api-fixture.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmind-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  const install = path.join(root, 'extension');
  for (const dir of [workspace, outside, install]) fs.mkdirSync(dir);
  const ext = {
    id: 'test.files', path: install, globalStorage: path.join(install, 'storage'),
    permissions: ['workspaceRead', 'workspaceWrite'],
  };
  const host = { state: { workspaceFolders: [{ path: workspace }] }, als: new AsyncLocalStorage(), notify() {} };
  const guard = createGuard(ext, () => host.state.workspaceFolders);
  const api = createFileSystemApi({ host, ext, need: guard.need, track: x => x, Disposable, Uri });
  return { root, workspace, outside, install, guard, api };
}

test('path containment accepts names beginning with two dots', () => {
  assert.equal(within('/workspace', '/workspace/..notes/file'), true);
  assert.equal(within('/workspace', '/workspace-other/file'), false);
  assert.equal(within('/workspace', '/outside'), false);
});

test('Node fs guard rejects existing and newly created paths through external symlinks', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.outside, 'secret'), 'private');
  fs.symlinkSync(f.outside, path.join(f.workspace, 'escape'), 'junction');
  const guarded = f.guard.moduleFor('node:fs', () => fs);
  assert.throws(() => guarded.readFileSync(path.join(f.workspace, 'escape/secret')), { code: 'EPERMISSION' });
  assert.throws(() => guarded.mkdirSync(path.join(f.workspace, 'escape/new'), { recursive: true }), { code: 'EPERMISSION' });
  assert.equal(fs.existsSync(path.join(f.outside, 'new')), false);
});

test('Node promise fs guard rejects symlink writes and permits new workspace files', async (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.outside, path.join(f.workspace, 'escape'), 'junction');
  const guarded = f.guard.moduleFor('fs/promises', () => fs.promises);
  await assert.rejects(guarded.writeFile(path.join(f.workspace, 'escape/new'), 'bad'), { code: 'EPERMISSION' });
  await guarded.writeFile(path.join(f.workspace, 'new'), 'good');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'new'), 'utf8'), 'good');
});

test('workspace.fs applies symlink checks to reads and writes', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.outside, 'secret'), 'private');
  fs.symlinkSync(f.outside, path.join(f.workspace, 'escape'), 'junction');
  await assert.rejects(f.api.fs.readFile(Uri.file(path.join(f.workspace, 'escape/secret'))), { code: 'NoPermissions' });
  await assert.rejects(f.api.fs.writeFile(Uri.file(path.join(f.workspace, 'escape/new')), new Uint8Array([1])), { code: 'NoPermissions' });
});

test('dangling external symlinks do not grant permission to future files', (t) => {
  const f = fixture(t);
  // A file symbolic link needs Developer Mode or administrator rights on Windows; without them there is nothing to test.
  try { fs.symlinkSync(path.join(f.outside, 'missing'), path.join(f.workspace, 'dangling')); }
  catch (error) { if (error.code === 'EPERM') { t.skip('this account may not create symbolic links'); return; } throw error; }
  assert.throws(() => f.guard.checkPath(path.join(f.workspace, 'dangling'), true), { code: 'ENOENT' });
});

test('openTextDocument rejects a symlink escape before requesting workbench access', async (t) => {
  const f = fixture(t);
  const { host, api } = apiFixture(['workspaceRead']);
  host.state.workspaceFolders = [{ path: f.workspace, name: 'Workspace' }];
  host.request = async () => assert.fail('outside document reached the bridge');
  fs.writeFileSync(path.join(f.outside, 'secret'), 'private');
  fs.symlinkSync(f.outside, path.join(f.workspace, 'escape'), 'junction');
  await assert.rejects(api.workspace.openTextDocument(Uri.file(path.join(f.workspace, 'escape/secret'))), { code: 'EPERMISSION' });
});

test('workspace.fs rename and copy modify actual files and respect overwrite', async (t) => {
  const f = fixture(t);
  const uri = name => Uri.file(path.join(f.workspace, name));
  await f.api.fs.writeFile(uri('source'), Buffer.from('content'));
  await f.api.fs.copy(uri('source'), uri('copied'));
  assert.equal(Buffer.from(await f.api.fs.readFile(uri('copied'))).toString(), 'content');
  await assert.rejects(f.api.fs.copy(uri('source'), uri('copied')), { code: 'FileExists' });
  await assert.rejects(f.api.fs.rename(uri('source'), uri('copied')), { code: 'FileExists' });
  await f.api.fs.rename(uri('source'), uri('copied'), { overwrite: true });
  await assert.rejects(f.api.fs.stat(uri('source')), { code: 'FileNotFound' });
  assert.equal(Buffer.from(await f.api.fs.readFile(uri('copied'))).toString(), 'content');
});

test('workspace.fs rename and copy refuse external destinations', async (t) => {
  const f = fixture(t);
  const source = Uri.file(path.join(f.workspace, 'source'));
  await f.api.fs.writeFile(source, Buffer.from('content'));
  fs.symlinkSync(f.outside, path.join(f.workspace, 'escape'), 'junction');
  const target = Uri.file(path.join(f.workspace, 'escape/new'));
  await assert.rejects(f.api.fs.copy(source, target), { code: 'NoPermissions' });
  await assert.rejects(f.api.fs.rename(source, target), { code: 'NoPermissions' });
  assert.equal(fs.existsSync(path.join(f.outside, 'new')), false);
});

test('custom filesystem rename and copy run as the provider and block traversal', async (t) => {
  const f = fixture(t);
  const calls = [];
  const provider = {
    stat() {}, readDirectory() {}, readFile() {},
    rename(...args) { calls.push(['rename', ...args]); },
    copy(...args) { calls.push(['copy', ...args]); },
  };
  f.api.registerFileSystemProvider('memory', provider, { isReadonly: false });
  const source = Uri.parse('memory:/source');
  const target = Uri.parse('memory:/target');
  await f.api.fs.rename(source, target);
  await f.api.fs.copy(source, target, { overwrite: true });
  assert.equal(calls[0][0], 'rename');
  assert.equal(calls[0][2].path, '/target');
  assert.deepEqual(calls[1][3], { overwrite: true });
  await assert.rejects(f.api.fs.copy(source, target.with({ path: '/../escape' })), { code: 'NoPermissions' });
  assert.equal(calls.length, 2);
});

test('readonly custom providers reject copy and rename before calling extension code', async (t) => {
  const f = fixture(t);
  f.api.registerFileSystemProvider('readonly', {
    stat() {}, readDirectory() {}, readFile() {},
    rename() { assert.fail('readonly rename called'); },
    copy() { assert.fail('readonly copy called'); },
  });
  const source = Uri.parse('readonly:/source');
  const target = Uri.parse('readonly:/target');
  await assert.rejects(f.api.fs.rename(source, target), { code: 'NoPermissions' });
  await assert.rejects(f.api.fs.copy(source, target), { code: 'NoPermissions' });
});
