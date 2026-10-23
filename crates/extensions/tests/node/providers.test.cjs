'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const WORKSPACE = path.resolve('provider-workspace').replaceAll('\\', '/');
const FILE = path.join(WORKSPACE, 'main.js');
const { fixture } = require('./rpc-fixture.cjs');

async function languageHost(t, code) {
  const host = await fixture(t, { 'test.language': { permissions: ['languages'], code: code.replaceAll('/workspace', WORKSPACE) } });
  await host.request('host/init', { documents: [{ path: FILE, text: 'function run() {}', languageId: 'javascript', version: 1 }] });
  await host.request('host/activate', { id: 'test.language' });
  const registration = (kind) => host.messages.find(m => m.method === 'languages/registered' && m.params.kind === kind).params;
  return { ...host, registration };
}

test('navigation, reference, highlight, symbol and folding providers serialize actual extension results', async (t) => {
  const host = await languageHost(t, `const vscode = require('vscode');
    exports.activate = () => {
      const selector = { language: 'javascript', scheme: 'file', pattern: new vscode.RelativePattern('/workspace', '*.js') };
      const range = new vscode.Range(0, 0, 0, 8);
      const selection = new vscode.Range(0, 1, 0, 4);
      const link = { targetUri: vscode.Uri.parse('memory:/target'), targetRange: range, targetSelectionRange: selection, originSelectionRange: selection };
      vscode.languages.registerTypeDefinitionProvider(selector, { provideTypeDefinition: () => link });
      vscode.languages.registerImplementationProvider(selector, { provideImplementation: () => [link] });
      vscode.languages.registerReferenceProvider(selector, { provideReferences: (doc, position, context) => {
        if (!context.includeDeclaration || position.character !== 2) throw Error('Reference context/position lost');
        return [new vscode.Location(vscode.Uri.file('/workspace/ref.js'), range)];
      } });
      vscode.languages.registerDocumentHighlightProvider(selector, { provideDocumentHighlights: () => [new vscode.DocumentHighlight(range, vscode.DocumentHighlightKind.Write)] });
      vscode.languages.registerDocumentSymbolProvider(selector, { provideDocumentSymbols: () => {
        const parent = new vscode.DocumentSymbol('run', 'function', vscode.SymbolKind.Function, range, selection);
        parent.children = [new vscode.DocumentSymbol('x', '', vscode.SymbolKind.Variable, selection, selection)];
        return [parent];
      } }, { label: 'Test symbols' });
      vscode.languages.registerFoldingRangeProvider(selector, { provideFoldingRanges: () => [new vscode.FoldingRange(0, 3, vscode.FoldingRangeKind.Region)] });
    };`);
  const provide = kind => host.request('host/provide', {
    handle: host.registration(kind).handle, path: FILE,
    position: { line: 0, character: 2 }, context: { includeDeclaration: true },
  });
  for (const kind of ['typeDefinition', 'implementation']) {
    const [location] = await provide(kind);
    assert.match(location.uri, /^memory:/);
    assert.equal(location.targetSelectionRange.startColumn, 1);
    assert.equal(location.originSelectionRange.endColumn, 4);
  }
  assert.equal((await provide('reference'))[0].path, path.join(WORKSPACE, 'ref.js'));
  assert.equal((await provide('highlight'))[0].kind, 2);
  assert.equal((await provide('documentSymbol'))[0].children[0].name, 'x');
  assert.equal(host.registration('documentSymbol').displayName, 'Test symbols');
  assert.deepEqual(await provide('folding'), [{ start: 0, end: 3, kind: 3 }]);
  assert.deepEqual(host.registration('folding').selector[0].pattern, { base: WORKSPACE, pattern: '*.js' });
  await host.request('host/deactivate', { id: 'test.language' });
  await assert.rejects(provide('folding'), /no longer registered/);
});

test('selectors prevent unrelated documents from reaching extension providers', async (t) => {
  const host = await languageHost(t, `const vscode = require('vscode');
    exports.activate = () => vscode.languages.registerReferenceProvider({ language: 'python', scheme: 'file', pattern: '**/*.py' }, {
      provideReferences() { throw Error('Incorrect document dispatched'); }
    });`);
  assert.equal(await host.request('host/provide', { handle: host.registration('reference').handle, path: FILE }), null);
});

test('provider cancellation reaches the extension token and discards late results', async (t) => {
  const host = await languageHost(t, `const vscode = require('vscode');
    exports.activate = () => vscode.languages.registerReferenceProvider('javascript', {
      provideReferences(doc, pos, context, token) {
        return new Promise(resolve => token.onCancellationRequested(() => {
          console.log('reference-cancelled');
          resolve([new vscode.Location(doc.uri, new vscode.Range(0,0,0,1))]);
        }));
      }
    });`);
  const pending = host.request('host/provide', { handle: host.registration('reference').handle, path: FILE, position: { line: 0, character: 0 }, requestId: 'cancel-test' });
  await host.request('host/cancelProvide', { requestId: 'cancel-test' });
  assert.equal(await pending, null);
  assert.ok(host.messages.some(m => m.method === 'log/output' && m.params.text.includes('reference-cancelled')));
});

test('deactivation cancels active provider requests before removing registrations', async (t) => {
  const host = await languageHost(t, `const vscode = require('vscode');
    exports.activate = () => vscode.languages.registerFoldingRangeProvider('javascript', {
      provideFoldingRanges(doc, context, token) { return new Promise(resolve => token.onCancellationRequested(() => resolve([]))); }
    });`);
  const pending = host.request('host/provide', { handle: host.registration('folding').handle, path: FILE, requestId: 'dispose-test' });
  await host.request('host/deactivate', { id: 'test.language' });
  assert.equal(await pending, null);
});

test('disposing a provider cancels its active requests', async (t) => {
  const host = await languageHost(t, `const vscode = require('vscode');
    exports.activate = () => {
      const registration = vscode.languages.registerFoldingRangeProvider('javascript', {
        provideFoldingRanges(doc, context, token) {
          const result = new Promise(resolve => token.onCancellationRequested(() => resolve([])));
          registration.dispose();
          return result;
        }
      });
    };`);
  const params = { handle: host.registration('folding').handle, path: FILE, requestId: 'unregister-test' };
  assert.equal(await host.request('host/provide', params), null);
  await assert.rejects(host.request('host/provide', params), /no longer registered/);
});

test('cancellation settles requests even when an extension ignores its token', async (t) => {
  const host = await languageHost(t, `const vscode = require('vscode');
    exports.activate = () => vscode.languages.registerReferenceProvider('javascript', {
      provideReferences() { return new Promise(() => {}); }
    });`);
  const params = { handle: host.registration('reference').handle, path: FILE,
    position: { line: 0, character: 0 }, requestId: 'ignored-cancel' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = host.request('host/provide', params);
    await host.request('host/cancelProvide', { requestId: params.requestId });
    assert.equal(await pending, null);
  }
});

test('cancellation callbacks retain their extension network permission restrictions', async (t) => {
  const host = await languageHost(t, `const vscode = require('vscode');
    exports.activate = () => vscode.languages.registerReferenceProvider('javascript', {
      provideReferences(doc, position, context, token) {
        token.onCancellationRequested(() => {
          fetch('data:text/plain,hello').then(
            () => console.log('cancellation-fetch-allowed'),
            error => console.log('cancellation-fetch:' + error.code));
        });
        return new Promise(() => {});
      }
    });`);
  const pending = host.request('host/provide', { handle: host.registration('reference').handle,
    path: FILE, position: { line: 0, character: 0 }, requestId: 'permission-cancel' });
  await host.request('host/cancelProvide', { requestId: 'permission-cancel' });
  await pending;
  // A following roundtrip also drains the fetch rejection's microtask/log output.
  await host.request('host/cancelProvide', { requestId: 'missing' });
  assert.ok(host.messages.some(m => m.method === 'log/output' && m.params.text.includes('cancellation-fetch:EPERMISSION')));
  assert.ok(!host.messages.some(m => m.method === 'log/output' && m.params.text.includes('cancellation-fetch-allowed')));
});
