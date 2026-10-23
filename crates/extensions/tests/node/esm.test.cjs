'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./rpc-fixture.cjs');

test('native ESM imports default/named vscode exports, top-level await and guarded fs named exports', async t => {
  const host = await fixture(t, { 'test.esm': { main: 'extension.mjs', permissions: ['commands'], files: { 'message.txt': 'hello esm' },
    code: `import vscode, { commands, Uri } from 'vscode'; import filesystem, { readFileSync } from 'node:fs'; await Promise.resolve();
      export function activate(context) { commands.registerCommand('esm.read', () => ({ value: readFileSync(context.asAbsolutePath('message.txt'), 'utf8'), same: filesystem.readFileSync === readFileSync, sameApi: vscode.commands === commands, scheme: Uri.file(context.extensionPath).scheme })); }` } });
  await host.request('host/activate', { id: 'test.esm' });
  assert.deepEqual(await host.request('host/executeCommand', { command: 'esm.read' }), { value: 'hello esm', same: true, sameApi: true, scheme: 'file' });
});

test('type-module package and nested ESM dependencies reload after disable and update', async t => {
  const host = await fixture(t, { 'test.module': { packageType: 'module', permissions: ['commands'], files: { 'helper.mjs': 'export const value = 1;' },
    code: `import { commands } from 'vscode'; import { value } from './helper.mjs'; await Promise.resolve(); export function activate() { commands.registerCommand('module.value', () => value); }` } });
  await host.request('host/activate', { id: 'test.module' });
  assert.equal(await host.request('host/executeCommand', { command: 'module.value' }), 1);
  await host.request('host/deactivate', { id: 'test.module' });
  fs.writeFileSync(path.join(host.extensions[0].path, 'helper.mjs'), 'export const value = 2;');
  await host.request('host/activate', { id: 'test.module' });
  assert.equal(await host.request('host/executeCommand', { command: 'module.value' }), 2);
});

test('ESM default/namespace builtin imports cannot bypass fs, process, worker or network permissions', async t => {
  const host = await fixture(t, {
    'test.files': { main: 'extension.mjs', permissions: ['commands'], code: `import { commands } from 'vscode'; import { readFile } from 'node:fs/promises'; export function activate() { commands.registerCommand('files.denied', () => readFile('/outside-openmind-permission', 'utf8')); }` },
    'test.process': { main: 'extension.mjs', permissions: [], code: `import cp from 'node:child_process'; export function activate() { return cp; }` },
    'test.network': { main: 'extension.mjs', permissions: [], code: `import * as net from 'node:net'; export function activate() { return net; }` },
    'test.worker': { main: 'extension.mjs', permissions: [], code: `import { Worker } from 'node:worker_threads'; export function activate() { return Worker; }` },
  });
  await host.request('host/activate', { id: 'test.files' });
  await assert.rejects(host.request('host/executeCommand', { command: 'files.denied' }), /filesystemOutsideWorkspace/);
  await assert.rejects(host.request('host/activate', { id: 'test.process' }), /processExecution/);
  await assert.rejects(host.request('host/activate', { id: 'test.network' }), /network/);
  await assert.rejects(host.request('host/activate', { id: 'test.worker' }), /processExecution/);
});

test('CommonJS dynamic import uses the owned vscode bridge and accepted CJS exports retain this binding', async t => {
  const host = await fixture(t, { 'test.dynamic': { permissions: ['commands'], code: `exports.value = 7; exports.activate = async function() { const v = await import('vscode'); v.commands.registerCommand('dynamic.value', () => this.value); };` } });
  await host.request('host/activate', { id: 'test.dynamic' });
  assert.equal(await host.request('host/executeCommand', { command: 'dynamic.value' }), 7);
});

test('native ESM evaluation retains extension ownership across top-level await', async t => {
  const host = await fixture(t, { 'test.context': { main: 'extension.mjs', permissions: ['commands'],
    code: `import { commands } from 'vscode'; await Promise.resolve(); let denied = false;
      try { await fetch('http://127.0.0.1:1'); } catch (error) { if (error.code !== 'EPERMISSION') throw error; denied = true; }
      export function activate() { commands.registerCommand('esm.context', () => denied); }` } });
  await host.request('host/activate', { id: 'test.context' });
  assert.equal(await host.request('host/executeCommand', { command: 'esm.context' }), true);
});

test('typeless JavaScript ESM entrypoints use native import resolution with top-level await', async t => {
  const host = await fixture(t, { 'test.typeless': { permissions: ['commands'], code: `import { commands } from 'vscode'; await Promise.resolve(); export function activate() { commands.registerCommand('typeless.value', () => 23); }` } });
  await host.request('host/activate', { id: 'test.typeless' });
  assert.equal(await host.request('host/executeCommand', { command: 'typeless.value' }), 23);
});
