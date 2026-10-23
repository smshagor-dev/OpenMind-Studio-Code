'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./rpc-fixture.cjs');

async function setup(t, code, permissions = ['commands', 'workspaceRead', 'workspaceWrite']) {
  const host = await fixture(t, { 'test.workbench': { code, permissions } });
  const root = host.extensions[0].path;
  await host.request('host/init', { workspaceFolders: [{ path: root, name: 'Fixture' }], isTrusted: true });
  const activate = () => host.request('host/activate', { id: 'test.workbench' });
  const call = (domain, op, params = {}) => host.request('host/workbench', { domain, op, ...params });
  return { ...host, root, activate, call };
}
async function until(get, predicate, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await get(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for extension workbench state.');
}

test('test controller discovery, selected execution and failure reporting reach the workbench', async t => {
  const h = await setup(t, `const v = require('vscode');
    exports.activate = () => {
      const c = v.tests.createTestController('math', 'Math');
      c.resolveHandler = () => {
        const suite = c.createTestItem('suite', 'Suite');
        suite.children.add(c.createTestItem('pass', 'Passing addition'));
        suite.children.add(c.createTestItem('fail', 'Failing assertion'));
        c.items.replace([suite]);
      };
      c.createRunProfile('Run math', v.TestRunProfileKind.Run, request => {
        const run = c.createTestRun(request, 'Math results');
        const selected = request.include || [...c.items].map(([,item]) => item);
        const visit = item => {
          run.enqueued(item); run.started(item);
          if (item.id === 'fail') run.failed(item, v.TestMessage.diff('Expected 5', '5', String(2+2)));
          else run.passed(item, 1);
          for (const [,child] of item.children) visit(child);
        };
        selected.forEach(visit); run.appendOutput('Executed extension tests\\n'); run.end();
      }, true);
    };`);
  await h.activate(); let data = await h.call('tests', 'snapshot'); const controller = data.controllers[0];
  await h.call('tests', 'discover', { controller: controller.handle });
  data = await h.call('tests', 'snapshot'); assert.equal(data.controllers[0].items[0].children.length, 2);
  await h.call('tests', 'run', { controller: controller.handle, profile: controller.profiles[0].id, include: ['fail'] });
  const run = (await h.call('tests', 'snapshot')).runs[0];
  assert.equal(run.ended, true); assert.equal(run.results.length, 1);
  assert.equal(run.results[0].status, 'failed'); assert.equal(run.results[0].messages[0].actual, '4');
  await h.request('host/deactivate', { id: 'test.workbench' });
  assert.equal((await h.call('tests', 'snapshot')).controllers.length, 0);
});

test('cancel test run signals the run-handler token and leaves a final skipped result', async t => {
  const h = await setup(t, `const v = require('vscode');
    exports.activate = () => {
      const c = v.tests.createTestController('cancel', 'Cancellation'); const item = c.createTestItem('one', 'Long test'); c.items.add(item);
      c.createRunProfile('Run', 1, (request, token) => {
        const run = c.createTestRun(request); run.started(item);
        return new Promise(resolve => token.onCancellationRequested(() => { run.skipped(item); run.end(); resolve(); }));
      });
    };`);
  await h.activate(); const c = (await h.call('tests', 'snapshot')).controllers[0];
  const running = h.call('tests', 'run', { controller: c.handle, profile: c.profiles[0].id });
  const data = await until(() => h.call('tests', 'snapshot'), data => data.runs.length > 0);
  await h.call('tests', 'cancel', { run: data.runs[0].id }); await running;
  assert.equal((await h.call('tests', 'snapshot')).runs[0].results[0].status, 'skipped');
});

test('SCM resources, selection, input validation, quick diff and commands are functional', async t => {
  const h = await setup(t, `const v = require('vscode');
    exports.activate = () => {
      const scm = v.scm.createSourceControl('sample', 'Sample SCM', v.Uri.file(__dirname));
      const group = scm.createResourceGroup('changes', 'Changes');
      group.resourceStates = [{ resourceUri: v.Uri.file(__dirname + '/file.txt'), command: { command: 'scm.open', arguments: ['opened'] } }];
      scm.quickDiffProvider = { provideOriginalResource: uri => uri.with({ scheme: 'original' }) };
      scm.inputBox.validateInput = value => value.length < 3 ? { message: 'Use at least 3 characters', type: 0 } : undefined;
      scm.acceptInputCommand = { command: 'scm.commit' };
      v.commands.registerCommand('scm.commit', () => { group.resourceStates = []; return scm.inputBox.value; });
      v.commands.registerCommand('scm.open', value => value);
    };`);
  await h.activate(); const provider = (await h.call('scm', 'snapshot')).providers[0];
  assert.equal(provider.groups[0].resources.length, 1);
  assert.equal(await h.call('scm', 'open', { provider: provider.handle, group: 'changes', index: 0 }), 'opened');
  assert.match(await h.call('scm', 'original', { provider: provider.handle, group: 'changes', index: 0 }), /^original:/);
  await assert.rejects(h.call('scm', 'accept', { provider: provider.handle, value: 'x' }), /at least 3/);
  assert.equal(await h.call('scm', 'accept', { provider: provider.handle, value: 'Commit example' }), 'Commit example');
  assert.equal((await h.call('scm', 'snapshot')).providers[0].groups[0].resources.length, 0);
  await h.request('host/deactivate', { id: 'test.workbench' }); assert.equal((await h.call('scm', 'snapshot')).providers.length, 0);
});

const notebookExtension = `const v = require('vscode');
exports.activate = () => {
  v.workspace.registerNotebookSerializer('example', {
    deserializeNotebook(bytes) {
      const data = JSON.parse(Buffer.from(bytes).toString()); const notebook = new v.NotebookData(data.cells.map(cell => {
        const value = new v.NotebookCellData(2, cell.value, 'javascript'); value.metadata = cell.metadata || {}; return value;
      })); notebook.metadata = data.metadata; return notebook;
    },
    serializeNotebook(data) { return Buffer.from(JSON.stringify({ metadata: data.metadata, cells: data.cells.map(cell => ({ value: cell.value, metadata: cell.metadata, outputs: cell.outputs })) })); }
  });
  const controller = v.notebooks.createNotebookController('double', 'example', 'Double numbers');
  controller.executeHandler = cells => { for (const cell of cells) {
    const execution = controller.createNotebookCellExecution(cell); execution.start();
    execution.replaceOutput([new v.NotebookCellOutput([v.NotebookCellOutputItem.text(String(Number(cell.document.getText()) * 2))])]); execution.end(true);
  } };
};`;

test('notebook serializer, editor changes, controller execution and save use actual files', async t => {
  const h = await setup(t, notebookExtension); const file = path.join(h.root, 'example.omnb');
  fs.writeFileSync(file, JSON.stringify({ metadata: { name: 'Preserve me' }, cells: [{ value: '21', metadata: { custom: 7 } }] }));
  await h.activate(); const uri = await h.call('notebooks', 'open', { type: 'example', path: file });
  let data = await h.call('notebooks', 'snapshot');
  await h.call('notebooks', 'execute', { uri, controller: data.controllers[0].handle });
  data = await h.call('notebooks', 'snapshot'); assert.equal(data.documents[0].cells[0].outputs[0].text, '42');
  await h.call('notebooks', 'edit', { uri, index: 0, version: data.documents[0].version, value: '22' });
  await assert.rejects(h.call('notebooks', 'edit', { uri, index: 0, version: 1, value: 'stale' }), /changed/);
  await h.call('notebooks', 'save', { uri }); const saved = JSON.parse(fs.readFileSync(file));
  assert.equal(saved.cells[0].value, '22'); assert.equal(saved.cells[0].metadata.custom, 7); assert.equal(saved.metadata.name, 'Preserve me');
  await h.call('notebooks', 'close', { uri }); assert.equal((await h.call('notebooks', 'snapshot')).documents.length, 0);
  await assert.rejects(h.call('notebooks', 'open', { type: 'example', path: path.join(h.root, '../outside.omnb') }), /permissions|Permission/i);
});

test('disabling a notebook extension preserves unsaved cells and makes save fail transparently', async t => {
  const h = await setup(t, notebookExtension); const file = path.join(h.root, 'example.omnb');
  fs.writeFileSync(file, JSON.stringify({ cells: [{ value: '1' }] })); await h.activate();
  const uri = await h.call('notebooks', 'open', { type: 'example', path: file }); const doc = (await h.call('notebooks', 'snapshot')).documents[0];
  await h.call('notebooks', 'edit', { uri, index: 0, version: doc.version, value: 'unsaved' });
  await h.request('host/deactivate', { id: 'test.workbench' });
  const retained = (await h.call('notebooks', 'snapshot')).documents[0];
  assert.equal(retained.unavailable, true); assert.equal(retained.cells[0].value, 'unsaved');
  await assert.rejects(h.call('notebooks', 'save', { uri }), /unavailable/);
  await assert.rejects(h.call('notebooks', 'close', { uri }), /Save or explicitly discard/);
});

test('debug adapter registration rejects extensions without process permission', async t => {
  const h = await setup(t, `exports.activate = () => require('vscode').debug.registerDebugAdapterDescriptorFactory('denied', {});`, ['commands']);
  await assert.rejects(h.activate(), /processExecution/);
});

test('all workbench namespaces reject unknown domains and operations explicitly', async t => {
  const h = await setup(t, 'exports.activate = () => {};'); await h.activate();
  await assert.rejects(h.call('../host', 'snapshot'), /Unknown extension workbench domain/);
  await assert.rejects(h.call('tests', 'run', { controller: 'missing' }), /not found/);
});

test('workspace execution remains blocked until trust is explicitly granted for the current roots', async t => {
  const h = await setup(t, `const v = require('vscode'); exports.activate = () => {
    const c = v.tests.createTestController('trust', 'Trust check');
    c.createRunProfile('Run', 1, request => { c.createTestRun(request).end(); });
    v.commands.registerCommand('trust.state', () => v.workspace.isTrusted);
  };`);
  await h.activate(); await h.request('host/init', { workspaceFolders: [{ path: h.root, name: 'Fixture' }], isTrusted: false });
  const controller = (await h.call('tests', 'snapshot')).controllers[0];
  const params = { controller: controller.handle, profile: controller.profiles[0].id };
  await assert.rejects(h.call('tests', 'run', params), /Trust this workspace/);
  await assert.rejects(h.call('tests', 'trust', { folders: ['wrong-root'] }), /workspace changed/);
  assert.equal(await h.request('host/executeCommand', { command: 'trust.state' }), false);
  await h.call('tests', 'trust', { folders: [h.root] });
  assert.equal(await h.request('host/executeCommand', { command: 'trust.state' }), true);
  assert.equal(await h.call('tests', 'run', params), true);
});

test('test item collections reject cycles and cross-controller ownership without losing existing children', async t => {
  const h = await setup(t, `const v = require('vscode'); exports.activate = () => {
    const c = v.tests.createTestController('tree', 'Tree'); const other = v.tests.createTestController('other', 'Other');
    const parent = c.createTestItem('parent', 'Parent'); const child = c.createTestItem('child', 'Child');
    c.items.add(parent); parent.children.add(child);
    let rejected = 0;
    for (const action of [() => child.children.add(parent), () => other.items.add(child), () => parent.children.replace([child, child])]) {
      try { action(); } catch { rejected++; }
    }
    v.commands.registerCommand('tree.result', () => ({ rejected, parent: child.parent.id, children: parent.children.size }));
  };`);
  await h.activate(); assert.deepEqual(await h.request('host/executeCommand', { command: 'tree.result' }), { rejected: 3, parent: 'parent', children: 1 });
});

test('real debugpy adapter launches a Python target and exposes frames, scopes and evaluation', { skip: !process.env.OPENMIND_DEBUGPY_PYTHON, timeout: 30000 }, async t => {
  const h = await setup(t, `const v = require('vscode');
    exports.activate = () => {
      v.debug.registerDebugAdapterDescriptorFactory('python-test', {
        createDebugAdapterDescriptor() { return new v.DebugAdapterExecutable(process.env.OPENMIND_DEBUGPY_PYTHON, ['-m', 'debugpy.adapter']); }
      });
      v.debug.addBreakpoints([new v.SourceBreakpoint(new v.Location(v.Uri.file(__dirname + '/target.py'), new v.Range(1,0,1,0)), true, 'value == 42')]);
    };`, ['commands', 'workspaceRead', 'processExecution']);
  const target = path.join(h.root, 'target.py'); fs.writeFileSync(target, 'value = 42\nprint("debug-target", value, flush=True)\n');
  await h.activate();
  assert.equal(await h.call('debug', 'start', { configuration: { type: 'python-test', name: 'Real Python', request: 'launch', program: target, stopOnEntry: false, console: 'internalConsole' } }), true);
  const data = await until(() => h.call('debug', 'snapshot'), value => value.sessions[0]?.state === 'paused');
  const session = data.sessions[0]; const args = { session: session.id };
  const threads = await h.call('debug', 'threads', { ...args, arguments: {} }); assert.ok(threads.threads.length);
  const stack = await h.call('debug', 'stackTrace', { ...args, arguments: { threadId: threads.threads[0].id } }); assert.ok(stack.stackFrames.length);
  const frame = stack.stackFrames[0]; assert.equal(frame.line, 2);
  const scopes = await h.call('debug', 'scopes', { ...args, arguments: { frameId: frame.id } }); assert.ok(scopes.scopes.length);
  const variables = await h.call('debug', 'variables', { ...args, arguments: { variablesReference: scopes.scopes[0].variablesReference } }); assert.ok(Array.isArray(variables.variables));
  const evaluated = await h.call('debug', 'evaluate', { ...args, arguments: { expression: 'value', frameId: frame.id, context: 'repl' } }); assert.equal(evaluated.result, '42');
  await h.call('debug', 'stop', args); assert.equal((await h.call('debug', 'snapshot')).sessions.length, 0);
});
