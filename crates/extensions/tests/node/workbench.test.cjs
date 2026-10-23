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

test('NotebookEdit inserts, replaces and deletes cells transactionally and preserves live cell identities', async t => {
  const h = await setup(t, notebookExtension + `
  const original = exports.activate;
  exports.activate = () => { original();
    v.commands.registerCommand('notebook.structure', async () => {
      const document = v.workspace.notebookDocuments[0]; const first = document.cellAt(0), second = document.cellAt(1);
      const events = []; const subscription = v.workspace.onDidChangeNotebookDocument(event => events.push({
        version: event.notebook.version, content: event.contentChanges.map(change => ({ start: change.range.start, end: change.range.end, added: change.addedCells.length, removed: change.removedCells.length })),
        metadata: event.metadata, cells: event.cellChanges.map(change => change.metadata)
      }));
      const edit = new v.WorkspaceEdit(); const added = new v.NotebookCellData(1, '# Added', 'markdown'); added.metadata = { inserted: true };
      edit.set(document.uri, [v.NotebookEdit.insertCells(1, [added]), v.NotebookEdit.updateCellMetadata(0, { replaced: 42 }), v.NotebookEdit.updateNotebookMetadata({ title: 'Updated' })]);
      const applied = await v.workspace.applyEdit(edit);
      const inserted = document.cellAt(1); const reindex = second.index;
      const replace = new v.WorkspaceEdit(); replace.set(document.uri, [new v.NotebookEdit(new v.NotebookRange(2, 3), [new v.NotebookCellData(2, '30', 'javascript')])]);
      await v.workspace.applyEdit(replace);
      const deletion = new v.WorkspaceEdit(); deletion.set(document.uri, [v.NotebookEdit.deleteCells(new v.NotebookRange(1, 2))]); await v.workspace.applyEdit(deletion);
      subscription.dispose(); await document.save();
      return { applied, firstStable: document.cellAt(0) === first, reindex, removedIndex: second.index,
        removedClosed: second.document.isClosed, insertedClosed: inserted.document.isClosed,
        texts: document.getCells().map(cell => cell.document.getText()), events, size: edit.size, textEntries: edit.entries().length };
    });
  };`);
  const file = path.join(h.root, 'structure.omnb'); fs.writeFileSync(file, JSON.stringify({ cells: [{ value: '10' }, { value: '20' }] }));
  await h.activate(); await h.call('notebooks', 'open', { type: 'example', path: file });
  const result = await h.request('host/executeCommand', { command: 'notebook.structure' });
  assert.equal(result.applied, true); assert.equal(result.firstStable, true); assert.equal(result.reindex, 2);
  assert.equal(result.removedIndex, -1); assert.equal(result.removedClosed, true); assert.equal(result.insertedClosed, true);
  assert.deepEqual(result.texts, ['10', '30']); assert.equal(result.events.length, 3);
  assert.deepEqual(result.events[0].content, [{ start: 1, end: 1, added: 1, removed: 0 }]);
  assert.deepEqual(result.events[0].metadata, { title: 'Updated' }); assert.deepEqual(result.events[0].cells, [{ replaced: 42 }]);
  assert.equal(result.size, 1); assert.equal(result.textEntries, 0);
  const saved = JSON.parse(fs.readFileSync(file)); assert.deepEqual(saved.metadata, { title: 'Updated' });
  assert.deepEqual(saved.cells.map(cell => cell.value), ['10', '30']); assert.deepEqual(saved.cells[0].metadata, { replaced: 42 });
});

test('invalid notebook edit transactions do not mutate any document or emit changes', async t => {
  const h = await setup(t, notebookExtension + `
  const original = exports.activate;
  exports.activate = () => { original(); v.commands.registerCommand('notebook.invalid', async () => {
    const [first, second] = v.workspace.notebookDocuments; const before = first.version; let changes = 0;
    const subscription = v.workspace.onDidChangeNotebookDocument(() => changes++); const errors = [];
    const edit = new v.WorkspaceEdit();
    edit.set(first.uri, [v.NotebookEdit.deleteCells(new v.NotebookRange(0, 1))]);
    edit.set(second.uri, [v.NotebookEdit.deleteCells(new v.NotebookRange(0, 100))]);
    try { await v.workspace.applyEdit(edit); } catch (error) { errors.push(error.message); }
    const overlapping = new v.WorkspaceEdit(); overlapping.set(first.uri, [v.NotebookEdit.deleteCells(new v.NotebookRange(0, 1)), v.NotebookEdit.insertCells(0, [new v.NotebookCellData(2, 'x', 'text')])]);
    try { await v.workspace.applyEdit(overlapping); } catch (error) { errors.push(error.message); }
    const mixed = new v.WorkspaceEdit(); mixed.set(first.uri, [v.NotebookEdit.deleteCells(new v.NotebookRange(0, 1))]);
    mixed.insert(v.Uri.file('other.txt'), new v.Position(0, 0), 'text');
    try { await v.workspace.applyEdit(mixed); } catch (error) { errors.push(error.message); }
    const confirmation = new v.WorkspaceEdit();
    try { confirmation.set(first.uri, [[v.NotebookEdit.deleteCells(new v.NotebookRange(0, 1)), { needsConfirmation: true }]]); } catch (error) { errors.push(error.message); }
    subscription.dispose(); return { errors, changes, unchanged: before === first.version, cells: first.cellCount, dirty: first.isDirty };
  }); };`);
  await h.activate(); for (const name of ['one', 'two']) { const file = path.join(h.root, name + '.omnb'); fs.writeFileSync(file, JSON.stringify({ cells: [{ value: name }] })); await h.call('notebooks', 'open', { type: 'example', path: file }); }
  const result = await h.request('host/executeCommand', { command: 'notebook.invalid' });
  assert.equal(result.errors.length, 4); assert.match(result.errors[0], /range/); assert.match(result.errors[1], /Overlapping/);
  assert.match(result.errors[2], /mixedNotebookAndText/); assert.match(result.errors[3], /needsConfirmation/);
  assert.equal(result.changes, 0); assert.equal(result.unchanged, true); assert.equal(result.cells, 1); assert.equal(result.dirty, false);
});

test('workbench cell insertion and deletion use versions and refuse active executions', async t => {
  const h = await setup(t, notebookExtension + `
  const original = exports.activate;
  exports.activate = () => { original(); const controller = v.notebooks.createNotebookController('hold', 'example', 'Hold');
    controller.executeHandler = cells => { for (const cell of cells) controller.createNotebookCellExecution(cell).start(); };
  };`);
  const file = path.join(h.root, 'ui.omnb'); fs.writeFileSync(file, JSON.stringify({ cells: [{ value: '1' }] }));
  await h.activate(); const uri = await h.call('notebooks', 'open', { type: 'example', path: file });
  let state = await h.call('notebooks', 'snapshot'); const original = state.documents[0].cells[0].id;
  await h.call('notebooks', 'insert', { uri, version: state.documents[0].version, index: 0, languageId: 'javascript' });
  state = await h.call('notebooks', 'snapshot'); assert.equal(state.documents[0].cells[1].id, original);
  await assert.rejects(h.call('notebooks', 'delete', { uri, version: 1, index: 1 }), /changed/);
  await h.call('notebooks', 'execute', { uri, controller: state.controllers.find(value => value.id === 'hold').handle });
  state = await h.call('notebooks', 'snapshot');
  await assert.rejects(h.call('notebooks', 'delete', { uri, version: state.documents[0].version, index: 0 }), /Stop notebook execution/);
  await h.call('notebooks', 'cancel', { uri }); state = await h.call('notebooks', 'snapshot');
  await h.call('notebooks', 'delete', { uri, version: state.documents[0].version, index: 0 });
  state = await h.call('notebooks', 'snapshot'); assert.equal(state.documents[0].cells.length, 1); assert.equal(state.documents[0].cells[0].id, original);
});

test('untitled notebooks save to a new file without overwriting existing files or losing edits on failure', async t => {
  const h = await setup(t, notebookExtension); await h.activate();
  const uri = await h.call('notebooks', 'new', { type: 'example', languageId: 'javascript' });
  let snapshot = await h.call('notebooks', 'snapshot'); assert.equal(snapshot.documents[0].dirty, true);
  await h.call('notebooks', 'edit', { uri, index: 0, version: snapshot.documents[0].version, value: 'saved from untitled' });
  const existing = path.join(h.root, 'existing.omnb'); fs.writeFileSync(existing, 'do not overwrite');
  await assert.rejects(h.call('notebooks', 'saveAs', { uri, path: existing }), /exists/i);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'do not overwrite');
  await assert.rejects(h.call('notebooks', 'saveAs', { uri, path: path.join(h.root, '../denied-save.omnb') }), /permission/i);
  snapshot = await h.call('notebooks', 'snapshot'); assert.equal(snapshot.documents[0].uri, uri); assert.equal(snapshot.documents[0].cells[0].value, 'saved from untitled');
  const target = path.join(h.root, 'new.omnb'); const saved = await h.call('notebooks', 'saveAs', { uri, path: target });
  assert.match(saved, /^file:/); assert.equal(JSON.parse(fs.readFileSync(target)).cells[0].value, 'saved from untitled');
  snapshot = await h.call('notebooks', 'snapshot'); assert.equal(snapshot.documents.length, 1); assert.equal(snapshot.documents[0].uri, saved); assert.equal(snapshot.documents[0].dirty, false);
});

test('notebook Save As detects changes during serialization and retains the unsaved source', async t => {
  const h = await setup(t, `const v = require('vscode'); let release;
    exports.activate = () => {
      v.workspace.registerNotebookSerializer('slow', {
        deserializeNotebook: bytes => new v.NotebookData(JSON.parse(Buffer.from(bytes).toString()).cells),
        serializeNotebook: data => new Promise(resolve => { release = () => resolve(Buffer.from(JSON.stringify(data))); })
      });
      v.commands.registerCommand('slow.release', () => { if (!release) throw new Error('not serializing'); release(); });
    };`);
  await h.activate(); const uri = await h.call('notebooks', 'new', { type: 'slow' });
  const target = path.join(h.root, 'race.omnb');
  const saving = h.call('notebooks', 'saveAs', { uri, path: target });
  // This host request follows Save As on the same stdio channel; serialization has yielded.
  const snapshot = await h.call('notebooks', 'snapshot');
  await h.call('notebooks', 'edit', { uri, index: 0, version: snapshot.documents[0].version, value: 'newer source' });
  await h.request('host/executeCommand', { command: 'slow.release' });
  await assert.rejects(saving, /changed during serialization/); assert.equal(fs.existsSync(target), false);
  assert.equal((await h.call('notebooks', 'snapshot')).documents[0].cells[0].value, 'newer source');
});

test('notebook structural edits require write permission and recheck symlink containment', async t => {
  const extension = notebookExtension + `
    const original = exports.activate;
    exports.activate = () => { original(); v.commands.registerCommand('notebook.modify', async () => {
      const document = v.workspace.notebookDocuments[0]; const edit = new v.WorkspaceEdit();
      edit.set(document.uri, [v.NotebookEdit.updateNotebookMetadata({ changed: true })]); return v.workspace.applyEdit(edit);
    }); };`;
  const readonly = await setup(t, extension, ['commands', 'workspaceRead']);
  const file = path.join(readonly.root, 'readonly.omnb'); fs.writeFileSync(file, JSON.stringify({ cells: [] }));
  await readonly.activate(); await readonly.call('notebooks', 'open', { type: 'example', path: file });
  await assert.rejects(readonly.request('host/executeCommand', { command: 'notebook.modify' }), /workspaceWrite/);
  assert.equal((await readonly.call('notebooks', 'snapshot')).documents[0].dirty, false);
  const writer = await setup(t, extension); const inside = path.join(writer.root, 'inside.omnb'); const outside = path.join(writer.root, '../outside.omnb');
  fs.writeFileSync(inside, JSON.stringify({ cells: [] })); fs.writeFileSync(outside, 'outside');
  await writer.activate(); await writer.call('notebooks', 'open', { type: 'example', path: inside });
  fs.unlinkSync(inside); fs.symlinkSync(outside, inside);
  await assert.rejects(writer.request('host/executeCommand', { command: 'notebook.modify' }), /filesystemOutsideWorkspace/);
  assert.equal((await writer.call('notebooks', 'snapshot')).documents[0].dirty, false); assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
});
