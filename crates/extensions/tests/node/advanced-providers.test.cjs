'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture } = require('./rpc-fixture.cjs');

async function setup(t, code, permissions = ['languages', 'commands', 'workspaceWrite']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmind-language-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'main.js'); fs.writeFileSync(file, 'let value = 1;');
  const host = await fixture(t, { 'test.language': { code: code.replaceAll('WORKSPACE_FILE', JSON.stringify(file)), permissions } });
  await host.request('host/init', { workspaceFolders: [{ path: root, name: 'test' }], documents: [{ path: file, languageId: 'javascript', text: 'let value = 1;', version: 1 }] });
  await host.request('host/activate', { id: 'test.language' });
  const registration = kind => host.messages.find(m => m.method === 'languages/registered' && m.params.kind === kind)?.params;
  const provide = (kind, params = {}) => host.request('host/provide', { handle: registration(kind)?.handle, path: file, position: { line: 0, character: 4 }, range: { startLine: 0, startColumn: 4, endLine: 0, endColumn: 9 }, ...params });
  return { ...host, root, file, provide, registration };
}

const rename = `const v = require('vscode'); exports.activate = () => v.languages.registerRenameProvider('javascript', {
  provideRenameEdits(doc, pos, name) { const edit = new v.WorkspaceEdit(); edit.replace(doc.uri, new v.Range(0,4,0,9), name); return edit; }
});`;

test('rename edits require the provider owner write permission', async t => {
  const host = await setup(t, rename, ['languages']);
  await assert.rejects(host.provide('rename', { newName: 'safe' }), /workspaceWrite/);
});

test('rename refuses symlink escapes and non-file edit targets before returning any edits', async t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'openmind-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const host = await setup(t, `const v = require('vscode'); exports.activate = () => v.languages.registerRenameProvider('javascript', {
    provideRenameEdits(doc, pos, name) { const edit = new v.WorkspaceEdit(); edit.insert(doc.uri, new v.Position(0,0), 'inside');
      edit.insert(name === 'virtual' ? v.Uri.parse('memory:/other') : v.Uri.file(name), new v.Position(0,0), 'outside'); return edit; }
  });`);
  fs.symlinkSync(outside, path.join(host.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(host.provide('rename', { newName: path.join(host.root, 'escape', 'other.js') }), /filesystemOutsideWorkspace/);
  await assert.rejects(host.provide('rename', { newName: 'virtual' }), /file URIs/);
  assert.equal(fs.existsSync(path.join(outside, 'other.js')), false);
});

test('code actions reject stale and released objects instead of running cached commands', async t => {
  const host = await setup(t, `const v = require('vscode'); exports.activate = () => {
    v.commands.registerCommand('run', () => 42);
    v.languages.registerCodeActionsProvider('javascript', { provideCodeActions: () => [{ title: 'Run', command: 'run' }], resolveCodeAction: action => action });
  };`);
  const [action] = await host.provide('codeAction');
  assert.equal(await host.provide('codeAction', { action: 'command', itemId: action.id }), 42);
  host.notify('host/documentChanged', { path: host.file, text: 'let changed = 2;', version: 2 });
  await assert.rejects(host.provide('codeAction', { action: 'resolve', itemId: action.id }), /stale/);
  const [fresh] = await host.provide('codeAction');
  await host.provide('codeAction', { action: 'release', itemIds: [fresh.id] });
  await assert.rejects(host.provide('codeAction', { action: 'command', itemId: fresh.id }), /no longer available/);
});

test('lazy resolution runs under provider permissions and refuses disabled action commands', async t => {
  const host = await setup(t, `const v = require('vscode'); exports.activate = () => {
    v.commands.registerCommand('run', () => 42);
    v.languages.registerCodeActionsProvider('javascript', {
      provideCodeActions: () => [{ title: 'Disabled', disabled: { reason: 'Not applicable' }, command: { command: 'run', title: 'Run' } }],
      resolveCodeAction() { require('node:child_process'); }
    });
  };`);
  const [item] = await host.provide('codeAction');
  assert.equal(item.disabled, 'Not applicable');
  await assert.rejects(host.provide('codeAction', { action: 'resolve', itemId: item.id }), /processExecution/);
  await assert.rejects(host.provide('codeAction', { action: 'command', itemId: item.id }), /disabled/);
});

test('rename cancellation settles an ignored extension promise and deactivation removes providers', async t => {
  const host = await setup(t, `const v = require('vscode'); exports.activate = () => v.languages.registerRenameProvider('javascript', { provideRenameEdits: () => new Promise(() => {}) });`);
  const pending = host.provide('rename', { newName: 'later', requestId: 'cancel-rename' });
  await host.request('host/cancelProvide', { requestId: 'cancel-rename' });
  assert.equal(await pending, null);
  const pendingAgain = host.provide('rename', { newName: 'later', requestId: 'disable-rename' });
  await host.request('host/deactivate', { id: 'test.language' });
  assert.equal(await pendingAgain, null);
  await assert.rejects(host.provide('rename'), /no longer registered/);
});

test('semantic token validation rejects malformed buffers and builder preserves sorted unsigned deltas', async t => {
  const host = await setup(t, `const v = require('vscode'); let invalid = true; exports.activate = () => {
    v.commands.registerCommand('tokens.valid', () => { invalid = false; });
    v.languages.registerDocumentSemanticTokensProvider('javascript', { provideDocumentSemanticTokens() {
      if (invalid) return { data: [0,1,2] };
      const b = new v.SemanticTokensBuilder({ tokenTypes: ['variable'], tokenModifiers: Array.from({length:32}, (_,i) => 'm'+i) });
      b.push(new v.Range(2,3,2,8), 'variable', ['m31']); b.push(0,4,5,0); return b.build('sorted');
    } }, { tokenTypes: ['variable'], tokenModifiers: [] });
  };`);
  await assert.rejects(host.provide('semanticTokens'), /Invalid semantic token data/);
  await host.request('host/executeCommand', { command: 'tokens.valid' });
  assert.deepEqual(await host.provide('semanticTokens'), { resultId: 'sorted', data: [0,4,5,0,0,2,3,5,0,2147483648] });
});

test('inlay-hint edits and color presentations cannot bypass workspace write permission', async t => {
  const host = await setup(t, `const v = require('vscode'); exports.activate = () => {
    v.languages.registerInlayHintsProvider('javascript', { provideInlayHints() { const hint = new v.InlayHint(new v.Position(0,0), 'type'); hint.textEdits = [v.TextEdit.insert(new v.Position(0,0), 'changed')]; return [hint]; } });
    v.languages.registerColorProvider('javascript', { provideDocumentColors: () => [], provideColorPresentations: () => [new v.ColorPresentation('#fff')] });
  };`, ['languages']);
  await assert.rejects(host.provide('inlayHints'), /workspaceWrite/);
  await assert.rejects(host.provide('color', { action: 'present', color: { red: 1, green: 1, blue: 1, alpha: 1 } }), /workspaceWrite/);
});

test('diagnostic aggregation preserves URI identities, duplicate entries and lifecycle events', async t => {
  const host = await setup(t, `const v = require('vscode'); let a, b; const uri = v.Uri.parse('memory:/file?query#fragment'); let changes = 0;
    exports.activate = context => {
      context.subscriptions.push(v.languages.onDidChangeDiagnostics(event => { if (event.uris[0].toString() === uri.toString()) changes++; }));
      a = v.languages.createDiagnosticCollection('same'); b = v.languages.createDiagnosticCollection('same');
      const diagnostic = new v.Diagnostic(new v.Range(0,0,0,1), 'first', v.DiagnosticSeverity.Warning);
      a.set([[uri, [diagnostic]], [uri, [new v.Diagnostic(diagnostic.range, 'second')]]]); b.set(uri, [diagnostic]);
      v.commands.registerCommand('diagnostics.read', () => ({ all: v.languages.getDiagnostics().map(([u, items]) => [u.toString(), items.map(i => i.message)]), count: v.languages.getDiagnostics(uri).length, changes }));
      v.commands.registerCommand('diagnostics.clear', () => { a.set(uri, undefined); b.dispose(); return { count: v.languages.getDiagnostics(uri).length, has: a.has(uri) }; });
    };`);
  assert.deepEqual(await host.request('host/executeCommand', { command: 'diagnostics.read' }), { all: [['memory:///file?query#fragment', ['first', 'second', 'first']]], count: 3, changes: 2 });
  assert.deepEqual(await host.request('host/executeCommand', { command: 'diagnostics.clear' }), { count: 0, has: false });
  await host.request('host/deactivate', { id: 'test.language' });
});

test('throwing provider event subscriptions and disposers cannot leak registrations or pending requests', async t => {
  const failed = await fixture(t, { 'test.failure': { permissions: ['languages'], code: `const v = require('vscode'); exports.activate = () => v.languages.registerCodeLensProvider('javascript', { onDidChangeCodeLenses() { throw Error('subscribe failed'); }, provideCodeLenses: () => [] });` } });
  await assert.rejects(failed.request('host/activate', { id: 'test.failure' }), /subscribe failed/);
  assert.equal(failed.messages.some(message => message.method === 'languages/registered'), false);
  const host = await setup(t, `const v = require('vscode'); exports.activate = () => v.languages.registerCodeLensProvider('javascript', {
    onDidChangeCodeLenses() { return { dispose() { throw Error('dispose failed'); } }; },
    provideCodeLenses: () => new Promise(() => {})
  });`);
  const pending = host.provide('codeLens', { requestId: 'disposing-lens' });
  await host.request('host/deactivate', { id: 'test.language' });
  assert.equal(await pending, null);
  await assert.rejects(host.provide('codeLens'), /no longer registered/);
});
