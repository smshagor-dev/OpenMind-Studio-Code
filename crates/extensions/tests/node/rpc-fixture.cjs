'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Exercise the actual stdio host, loader and extension API, without a mock host.
async function fixture(t, definitions, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmind-host-'));
  const extensions = Object.entries(definitions).map(([id, definition]) => {
    const dir = path.join(root, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, definition.main || 'extension.js'), definition.code);
    if (definition.packageType) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: definition.packageType }));
    for (const [name, source] of Object.entries(definition.files || {})) { const target = path.join(dir, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source); }
    return {
      id, path: dir, main: definition.main || 'extension.js',
      globalStorage: path.join(dir, 'storage'), logPath: path.join(dir, 'logs'),
      permissions: definition.permissions || ['commands'],
      manifest: { extensionDependencies: definition.dependencies || [] },
    };
  });
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../host/host.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const messages = [];
  const listeners = new Set();
  let next = 0;
  let buffer = Buffer.alloc(0);
  function send(message) {
    const body = Buffer.from(JSON.stringify(message));
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
      if (buffer.length < end + 4 + length) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
      buffer = buffer.subarray(end + 4 + length);
      messages.push(message);
      if (message.method && message.id === undefined) for (const listener of listeners) listener(message);
      if (message.method && message.id !== undefined) {
        Promise.resolve().then(() => options.handleRequest ? options.handleRequest(message.method, message.params) : null)
          .then(result => send({ jsonrpc: '2.0', id: message.id, result: result ?? null }),
            error => send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error?.message || error) } }));
      } else if (message.id !== undefined) {
        const waiting = pending.get(message.id);
        if (!waiting) continue;
        pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result);
      }
    }
  });
  child.on('exit', () => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('Host exited before answering'));
    }
    pending.clear();
  });
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Host timed out: ${method}`));
      }, method === 'host/workbench' && params.domain === 'debug' ? 25000 : 3000);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  t.after(async () => {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await request('host/init', { extensions });
  return { request, messages, extensions, notify(method, params = {}) { send({ jsonrpc: '2.0', method, params }); }, onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

module.exports = { fixture };
