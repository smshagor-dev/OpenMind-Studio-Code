'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./rpc-fixture.cjs');

test('a restarted host preserves dirty native virtual documents when their provider registers again', async t => {
 const host = await fixture(t, { 'test.restorevirtual': { permissions: ['commands','workspaceRead','workspaceWrite'], code: `const v=require('vscode');let reads=0;exports.activate=()=>{v.workspace.registerFileSystemProvider('restored',{stat:()=>({type:1,size:4,mtime:0,ctime:0}),readDirectory:()=>[],readFile:()=>{reads++;return Buffer.from('disk')},writeFile:()=>{}},{isReadonly:false});v.commands.registerCommand('restoreVirtual',async()=>{const d=await v.workspace.openTextDocument(v.Uri.parse('restored:/draft.txt'));return{text:d.getText(),dirty:d.isDirty,untitled:d.isUntitled,reads}})}` } });
 await host.request('host/init', { documents: [{path:'restored:///draft.txt',text:'unsaved changes',version:8,languageId:'plaintext',virtual:true,native:true,readonly:false,isDirty:true}] });
 await host.request('host/register', { extension: { ...host.extensions[0], manifest: { activationEvents: ['onFileSystem:restored'] } } });
 await host.request('host/fs', { scheme: 'restored', path: '/draft.txt', op: 'writeFile', base64: Buffer.from('user save').toString('base64') });
 assert.deepEqual(await host.request('host/executeCommand',{command:'restoreVirtual'}),{text:'unsaved changes',dirty:true,untitled:false,reads:0});
});

test('read-only virtual providers reject edits without creating a writable native model', async t => {
 const host = await fixture(t, { 'test.readonlyvirtual': { permissions: ['commands','workspaceRead','workspaceWrite'], code: `const v=require('vscode');exports.activate=()=>{v.workspace.registerFileSystemProvider('locked',{stat:()=>({type:1,size:4,mtime:0,ctime:0}),readDirectory:()=>[],readFile:()=>Buffer.from('safe')});v.commands.registerCommand('lockedEdit',async()=>{const d=await v.workspace.openTextDocument(v.Uri.parse('locked:/draft.txt'));const e=new v.WorkspaceEdit();e.insert(d.uri,new v.Position(0,0),'bad');return v.workspace.applyEdit(e)})}` } });
 await host.request('host/activate',{id:'test.readonlyvirtual'});
 await assert.rejects(host.request('host/executeCommand',{command:'lockedEdit'}),/read-only/);
 assert.equal(host.messages.filter(m=>m.method==='workspace/openVirtualTextDocument').length,0);
});

test('saving a restored virtual document during provider activation does not wait for its own activation', async t => {
 let host;
 host = await fixture(t, { 'test.activationsave': { permissions: ['commands','workspaceRead','workspaceWrite'], code: `const v=require('vscode');exports.activate=async()=>{let saved='';v.workspace.registerFileSystemProvider('bootwrite',{stat:()=>({type:1,size:0,mtime:0,ctime:0}),readDirectory:()=>[],readFile:()=>Buffer.from(''),writeFile:(uri,bytes)=>{saved=Buffer.from(bytes).toString('utf8')}},{isReadonly:false});await v.workspace.textDocuments[0].save();v.commands.registerCommand('bootSaved',()=>saved)}` } }, {
   async handleRequest(method,p) {
     if (method !== 'workspace/saveDocument') throw Error('Unexpected request '+method);
     await host.request('host/fs',{scheme:'bootwrite',path:'/draft.txt',op:'writeFile',base64:Buffer.from('restored edits').toString('base64')});
     return {saved:true};
   }
 });
 await host.request('host/init',{documents:[{path:'bootwrite:///draft.txt',text:'restored edits',version:2,languageId:'plaintext',isDirty:true,virtual:true,native:true,readonly:false}]});
 await host.request('host/register',{extension:{...host.extensions[0],manifest:{activationEvents:['onFileSystem:bootwrite']}}});
 await host.request('host/activate',{id:'test.activationsave'});
 assert.equal(await host.request('host/executeCommand',{command:'bootSaved'}),'restored edits');
});
