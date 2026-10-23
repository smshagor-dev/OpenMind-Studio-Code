'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./rpc-fixture.cjs');
const pane=(id,column)=>({id,path:'/tmp/shared.txt',viewColumn:column,selections:[{anchorLine:0,anchorColumn:0,activeLine:0,activeColumn:0}],tabSize:4,insertSpaces:true});

test('showTextDocument forwards object and legacy options and returns the exact pane supplied by the UI',async t=>{
 const calls=[];
 const host=await fixture(t,{'test.showoptions':{permissions:['commands','workspaceRead'],code:`const v=require('vscode');exports.activate=()=>{
 v.commands.registerCommand('showOptions',async(kind)=>{const doc=v.workspace.textDocuments[0];const e=kind==='legacy'?await v.window.showTextDocument(doc,v.ViewColumn.Two,true):await v.window.showTextDocument(doc,{viewColumn:v.ViewColumn.Beside,preserveFocus:true,preview:true,selection:new v.Range(0,1,0,3)});return{column:e.viewColumn,same:e===v.window.visibleTextEditors[1],active:e===v.window.activeTextEditor}});
 v.commands.registerCommand('invalidOptions',()=>v.window.showTextDocument(v.workspace.textDocuments[0],{viewColumn:10}));
 }`}}, {handleRequest(method,params){if(method==='ui/showTextDocument'){calls.push(params);return{ok:true,editorId:'right'}}return{ok:true}}});
 await host.request('host/activate',{id:'test.showoptions'});
 host.notify('host/documentOpened',{path:'/tmp/shared.txt',text:'hello',languageId:'plaintext',version:1,isDirty:false});
 host.notify('host/editorSnapshot',{editors:[pane('left',1),pane('right',2)],activeId:'left'});
 assert.deepEqual(await host.request('host/executeCommand',{command:'showOptions'}),{column:2,same:true,active:false});
 assert.equal(calls[0].viewColumn,-2);assert.equal(calls[0].preserveFocus,true);assert.equal(calls[0].preview,true);
 assert.deepEqual(calls[0].selection,{startLine:0,startColumn:1,endLine:0,endColumn:3});
 assert.ok(calls[0].requestId.startsWith('test.showoptions:show:'));
 assert.deepEqual(await host.request('host/executeCommand',{command:'showOptions',args:['legacy']}),{column:2,same:true,active:false});
 assert.equal(calls[1].viewColumn,2);assert.equal(calls[1].preserveFocus,true);assert.equal(calls[1].preview,undefined);
 assert.notEqual(calls[0].requestId,calls[1].requestId);
 await assert.rejects(host.request('host/executeCommand',{command:'invalidOptions'}),/view column/);assert.equal(calls.length,2);
});

test('an exact requested pane waits for its snapshot even when the same file is already active elsewhere',async t=>{
 let host;host=await fixture(t,{'test.exactshow':{permissions:['commands','workspaceRead'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('exactShow',async()=>{const e=await v.window.showTextDocument(v.workspace.textDocuments[0],{viewColumn:2});return{column:e.viewColumn,same:e===v.window.visibleTextEditors[1]}})`}}, {handleRequest(method){if(method==='ui/showTextDocument'){setTimeout(()=>host.notify('host/editorSnapshot',{editors:[pane('left',1),pane('new-pane',2)],activeId:'left'}),30);return{ok:true,editorId:'new-pane'}}return{ok:true}}});
 await host.request('host/activate',{id:'test.exactshow'});
 host.notify('host/documentOpened',{path:'/tmp/shared.txt',text:'hello',languageId:'plaintext',version:1,isDirty:false});
 host.notify('host/editorSnapshot',{editors:[pane('left',1)],activeId:'left'});
 assert.deepEqual(await host.request('host/executeCommand',{command:'exactShow'}),{column:2,same:true});
});
