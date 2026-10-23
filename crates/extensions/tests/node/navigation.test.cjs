'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./rpc-fixture.cjs');
const code = `const v = require('vscode'); exports.activate = () => {
 const range = new v.Range(0, 0, 0, 3);
 const item = new v.CallHierarchyItem(v.SymbolKind.Function, 'root', 'detail', v.Uri.file(__filename), range, range);
 item.secret = { value: 42 };
 v.languages.registerCallHierarchyProvider('javascript', {
  prepareCallHierarchy() { return item; },
  provideCallHierarchyIncomingCalls(value) { if(value !== item || value.secret.value !== 42) throw Error('Lost identity'); return [new v.CallHierarchyIncomingCall(item, [range])]; },
  provideCallHierarchyOutgoingCalls(value) { if(value !== item) throw Error('Lost identity'); return [new v.CallHierarchyOutgoingCall(item, [range])]; }
 });
 const type = new v.TypeHierarchyItem(v.SymbolKind.Class, 'Base', '', item.uri, range, range);
 v.languages.registerTypeHierarchyProvider('javascript', { prepareTypeHierarchy() {return [type]}, provideTypeHierarchySupertypes(value) {if(value !== type) throw Error('Lost type'); return [type]}, provideTypeHierarchySubtypes() {return []} });
 const symbol = { name: 'root', kind: v.SymbolKind.Function, location: { uri: item.uri }, secret: 42 };
 v.languages.registerWorkspaceSymbolProvider({provideWorkspaceSymbols(query) {return query === 'root' ? [symbol] : []}, resolveWorkspaceSymbol(value) { if(value !== symbol) throw Error('Lost symbol'); value.location.range = range; return value; }});
};`;
async function setup(t) {
 const host = await fixture(t, { 'test.navigation': { code, permissions: ['languages'] } });
 const file = path.join(host.extensions[0].path, 'extension.js');
 await host.request('host/init', { documents: [{ path: file, text: 'abc', languageId: 'javascript', version: 1 }] });
 await host.request('host/activate', { id: 'test.navigation' });
 const snapshot = await host.request('host/workbench', {domain:'languages',op:'snapshot'});
 const handle = kind => snapshot.providers.find(p => p.kind === kind).handle;
 const provide = (kind, params) => host.request('host/provide', {handle:handle(kind),path:file,position:{line:0,character:0},...params});
 return {...host,file,handle,provide};
}
test('call and type hierarchies retain original objects across requests and release results', async t => {
 const host = await setup(t);
 const [root] = await host.provide('callHierarchy', {action:'prepare'});
 assert.equal(root.name, 'root');
 const [incoming] = await host.provide('callHierarchy', {action:'incoming',itemId:root.id});
 assert.equal(incoming.item.name, 'root'); assert.deepEqual(incoming.ranges,[{startLine:0,startColumn:0,endLine:0,endColumn:3}]);
 assert.equal((await host.provide('callHierarchy',{action:'outgoing',itemId:root.id}))[0].item.name,'root');
 const [type] = await host.provide('typeHierarchy',{action:'prepare'});
 assert.equal((await host.provide('typeHierarchy',{action:'supertypes',itemId:type.id}))[0].name,'Base');
 assert.deepEqual(await host.provide('typeHierarchy',{action:'subtypes',itemId:type.id}),[]);
 await host.provide('callHierarchy',{action:'release',itemIds:[root.id]});
 await assert.rejects(host.provide('callHierarchy',{action:'incoming',itemId:root.id}),/stale/);
});
test('workspace symbol search works without a document and resolves extension-owned symbols', async t => {
 const host = await setup(t);
 const [symbol] = await host.request('host/workbench',{domain:'languages',op:'search',handle:host.handle('workspaceSymbol'),query:'root'});
 assert.equal(symbol.name,'root'); assert.equal(symbol.range,undefined);
 const resolved = await host.provide('workspaceSymbol',{action:'resolve',itemId:symbol.id});
 assert.equal(resolved.range.endColumn,3);
 await host.request('host/deactivate',{id:'test.navigation'});
 assert.deepEqual((await host.request('host/workbench',{domain:'languages',op:'snapshot'})).providers,[]);
 await assert.rejects(host.provide('workspaceSymbol',{query:'root'}),/no longer registered/);
});
test('navigation workbench cancellation settles providers that ignore their cancellation token',async t=>{
 const host=await fixture(t,{'test.slow':{permissions:['languages'],code:`const v=require('vscode');exports.activate=()=>v.languages.registerWorkspaceSymbolProvider({provideWorkspaceSymbols(){return new Promise(()=>{})}})`}});
 await host.request('host/activate',{id:'test.slow'});
 const handle=(await host.request('host/workbench',{domain:'languages',op:'snapshot'})).providers[0].handle;
 const pending=host.request('host/workbench',{domain:'languages',op:'search',handle,query:'x',requestId:'navigation-cancel'});
 await host.request('host/workbench',{domain:'languages',op:'cancel',requestId:'navigation-cancel'});
 assert.equal(await pending,null);
 const interrupted=host.request('host/workbench',{domain:'languages',op:'search',handle,query:'x',requestId:'navigation-disable'});
 await host.request('host/deactivate',{id:'test.slow'});assert.equal(await interrupted,null);
});
