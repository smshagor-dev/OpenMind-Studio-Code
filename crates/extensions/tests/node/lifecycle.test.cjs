'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fixture } = require('./rpc-fixture.cjs');

test('simultaneous activation shares one result and runs extension code once', async (t) => {
  const host = await fixture(t, { 'test.slow': { code: `
    const vscode = require('vscode');
    let count = 0;
    exports.activate = async () => {
      count++;
      await new Promise(resolve => setTimeout(resolve, 40));
      vscode.commands.registerCommand('slow.count', () => count);
    };
  ` } });
  const results = await Promise.all(Array.from({ length: 10 }, () => host.request('host/activate', { id: 'test.slow' })));
  assert.ok(results.every(result => result.activated));
  assert.equal(await host.request('host/executeCommand', { command: 'slow.count' }), 1);
  assert.equal(host.messages.filter(m => m.method === 'commands/registered').length, 1);
});

test('concurrent dependants share dependency activation and receive its exports', async (t) => {
  const host = await fixture(t, {
    'test.base': { code: `exports.activate = async () => {
      await new Promise(resolve => setTimeout(resolve, 30)); return { value: 42 };
    };` },
    ...Object.fromEntries(['left', 'right'].map(name => [`test.${name}`, {
      dependencies: ['test.base'], code: `const vscode = require('vscode');
      exports.activate = async () => {
        const base = await vscode.extensions.getExtension('test.base').activate();
        vscode.commands.registerCommand('${name}.value', () => base.value);
      };`,
    }])),
  });
  await Promise.all(['left', 'right'].map(name => host.request('host/activate', { id: `test.${name}` })));
  for (const name of ['left', 'right']) {
    assert.equal(await host.request('host/executeCommand', { command: `${name}.value` }), 42);
  }
});

test('concurrent circular dependencies reject instead of deadlocking', async (t) => {
  const host = await fixture(t, {
    'test.a': { dependencies: ['test.b'], code: 'exports.activate = () => {};' },
    'test.b': { dependencies: ['test.a'], code: 'exports.activate = () => {};' },
  });
  const results = await Promise.allSettled(['test.a', 'test.b'].map(id => host.request('host/activate', { id })));
  assert.ok(results.every(result => result.status === 'rejected' && /Circular extension dependency/.test(result.reason.message)));
});

test('runtime activation cycles reject through extensions.getExtension().activate()', async (t) => {
  const host = await fixture(t, Object.fromEntries([['a', 'b'], ['b', 'a']].map(([name, other]) => [
    `test.${name}`, { code: `const vscode = require('vscode');
      exports.activate = () => vscode.extensions.getExtension('test.${other}').activate();` },
  ])));
  await assert.rejects(host.request('host/activate', { id: 'test.a' }), /Circular extension dependency/);
});

test('failed activation disposes registrations and reloads corrected entrypoint', async (t) => {
  const host = await fixture(t, { 'test.retry': { code: `const vscode = require('vscode');
    vscode.commands.registerCommand('retry.result', () => 'stale');
    throw new Error('broken module');` } });
  await assert.rejects(host.request('host/activate', { id: 'test.retry' }), /broken module/);
  await assert.rejects(host.request('host/executeCommand', { command: 'retry.result' }), /isn't registered/);
  fs.writeFileSync(path.join(host.extensions[0].path, 'extension.js'), `const vscode = require('vscode');
    exports.activate = () => vscode.commands.registerCommand('retry.result', () => 'fixed');`);
  await host.request('host/activate', { id: 'test.retry' });
  assert.equal(await host.request('host/executeCommand', { command: 'retry.result' }), 'fixed');
});

test('unregister during activation waits then removes commands and runs deactivate once', async (t) => {
  const host = await fixture(t, { 'test.remove': { code: `const vscode = require('vscode');
    exports.activate = async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      vscode.commands.registerCommand('remove.value', () => 1);
    };
    exports.deactivate = async () => {
      await new Promise(resolve => setTimeout(resolve, 10)); console.log('deactivated-once');
    };` } });
  const activation = host.request('host/activate', { id: 'test.remove' });
  const removal = host.request('host/unregister', { id: 'test.remove' });
  const deactivation = host.request('host/deactivate', { id: 'test.remove' });
  await Promise.all([activation, removal, deactivation]);
  await assert.rejects(host.request('host/executeCommand', { command: 'remove.value' }), /isn't registered/);
  await assert.rejects(host.request('host/activate', { id: 'test.remove' }), /not known/);
  assert.equal(host.messages.filter(m => m.method === 'log/output' && m.params.text.includes('deactivated-once')).length, 1);
});

test('cross-extension commands execute under the registered owner permissions', async (t) => {
  const host = await fixture(t, {
    'test.caller': { permissions: ['commands', 'network'], code: `const vscode = require('vscode');
      exports.activate = () => vscode.commands.registerCommand('caller.run', () => vscode.commands.executeCommand('callee.fetch'));` },
    'test.callee': { code: `const vscode = require('vscode');
      exports.activate = () => vscode.commands.registerCommand('callee.fetch', async () => {
        try { await fetch('data:text/plain,hello'); return 'allowed'; }
        catch (error) { return error.code; }
      });` },
  });
  for (const id of ['test.caller', 'test.callee']) await host.request('host/activate', { id });
  assert.equal(await host.request('host/executeCommand', { command: 'caller.run' }), 'EPERMISSION');
});

test('subscription disposal keeps the extension permission context', async t => {
  const host = await fixture(t, { 'test.cleanup': { code: `
    exports.activate = context => context.subscriptions.push({ dispose() {
      fetch('data:text/plain,secret').then(() => console.log('cleanup-allowed'), error => console.log('cleanup:' + error.code));
    } });` } });
  await host.request('host/activate', { id: 'test.cleanup' });
  await host.request('host/deactivate', { id: 'test.cleanup' });
  await host.request('host/cancelProvide', { requestId: 'missing' });
  assert.ok(host.messages.some(message => message.method === 'log/output' && message.params.text.includes('cleanup:EPERMISSION')));
  assert.ok(!host.messages.some(message => message.method === 'log/output' && message.params.text.includes('cleanup-allowed')));
});
