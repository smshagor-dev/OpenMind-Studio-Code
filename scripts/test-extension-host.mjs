// Runs real Node extension-host integration tests without starting the desktop UI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostJs = path.join(root, 'crates/extensions/host/host.js');
const fixtures = path.join(root, 'crates/extensions/tests/fixtures');

let child;
let buffer = Buffer.alloc(0);
let serial = 0;
const pending = new Map();
const notifications = [];
let waitReady;
const ready = new Promise((resolve) => { waitReady = resolve; });
const scratch = mkdtempSync(path.join(tmpdir(), 'openmind-extension-host-'));

function frame(message) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
  return Buffer.concat([Buffer.from('Content-Length: ' + payload.length + '\r\n\r\n'), payload]);
}

function receive(message) {
  if (message.method) {
    notifications.push(message);
    if (message.method === 'host/ready') waitReady();
    if (message.id !== undefined) child.stdin.write(frame({ id: message.id, result: null }));
    return;
  }
  if (message.id === undefined) return;
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  clearTimeout(waiting.timer);
  if (message.error) waiting.reject(new Error(message.error.message));
  else waiting.resolve(message.result);
}

function call(method, params = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Extension host timed out: ' + method));
    }, 8000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(frame({ id, method, params }));
  });
}

function descriptor(id, dir, permissions = ['commands']) {
  return {
    id, path: dir, main: './extension.js', permissions,
    manifest: { name: id.split('.').at(-1), publisher: id.split('.')[0], version: '1.0.0' },
    globalStorage: path.join(scratch, id, 'state'),
    workspaceStorage: path.join(scratch, id, 'workspace'),
    logPath: path.join(scratch, id, 'logs'),
  };
}

before(async () => {
  child = spawn(process.execPath, [hostJs], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) break;
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'));
      if (!match) throw new Error('Invalid extension-host protocol header');
      const length = Number(match[1]);
      if (buffer.length < end + 4 + length) break;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
      buffer = buffer.subarray(end + 4 + length);
      receive(message);
    }
  });
  child.on('exit', (code) => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('Host exited unexpectedly: ' + code));
    }
    pending.clear();
  });
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Host did not become ready')), 8000))]);
  await call('host/init', { extensions: [], configuration: {}, workspaceFolders: [], documents: [] });
});

after(async () => {
  if (child && !child.killed) {
    try { await call('host/shutdown'); } catch { /* already stopped */ }
    child.kill();
  }
  rmSync(scratch, { recursive: true, force: true });
});

test('installable command fixture activates, runs, deactivates and can be reactivated', async () => {
  const id = 'openmind-samples.sample-command';
  await call('host/register', { extension: descriptor(id, path.join(fixtures, 'command-basic')) });
  assert.equal((await call('host/activate', { id })).activated, true);
  assert.equal(await call('host/executeCommand', { command: 'sampleCommand.hello' }), 'hello');
  assert.equal((await call('host/deactivate', { id })).deactivated, true);
  await assert.rejects(call('host/executeCommand', { command: 'sampleCommand.hello' }), /not registered|isn't registered/);
  assert.equal((await call('host/activate', { id })).activated, true);
});

test('failed partial activation removes previously registered commands', async () => {
  const dir = path.join(scratch, 'partial');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'extension.js'), "const vscode = require('vscode'); exports.activate = () => { vscode.commands.registerCommand('broken.command', () => 1); throw Error('intentional activation failure'); };");
  const id = 'test.partial';
  await call('host/register', { extension: descriptor(id, dir) });
  await assert.rejects(call('host/activate', { id }), /intentional activation failure/);
  await assert.rejects(call('host/executeCommand', { command: 'broken.command' }), /not registered|isn't registered/);
});

test('unhandled exception quarantines one extension while other commands still work', async () => {
  const dir = path.join(scratch, 'crashing');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'extension.js'), "exports.activate = () => { setTimeout(() => { throw Error('fixture crash'); }, 0); };");
  const id = 'test.crashing';
  await call('host/register', { extension: descriptor(id, dir) });
  await call('host/activate', { id });
  const deadline = Date.now() + 4000;
  while (!notifications.some((message) => message.method === 'extensions/failed' && message.params.id === id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(notifications.some((message) => message.method === 'extensions/failed' && message.params.id === id));
  await assert.rejects(call('host/activate', { id }), /Restart the extension host/);
  assert.equal(await call('host/executeCommand', { command: 'sampleCommand.hello' }), 'hello');
});

