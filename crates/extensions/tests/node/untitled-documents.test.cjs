'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {fixture}=require('./rpc-fixture.cjs');

test('untitled documents have unique identities, reopen by URI and keep URI workspace edit targets',async t=>{
 let next=0;const calls=[];
 const host=await fixture(t,{'test.unsaved':{permissions:['commands','workspaceRead','workspaceWrite'],code:`const v=require('vscode');exports.activate=()=>{
 v.commands.registerCommand('unsaved',async()=>{const a=await v.workspace.openTextDocument({content:'a',language:'markdown'}),b=await v.workspace.openTextDocument();const same=await v.workspace.openTextDocument(a.uri);const edit=new v.WorkspaceEdit();edit.insert(a.uri,new v.Position(0,1),'!');return{first:a.uri.toString(),second:b.uri.toString(),same:same===a,untitled:a.isUntitled,language:a.languageId,applied:await v.workspace.applyEdit(edit),saved:await a.save()}});
 }`}}, {handleRequest(method,p){calls.push({method,p});if(method==='workspace/createUntitled')return{path:'untitled://openmind/doc-'+(++next),text:p.content,languageId:p.language,version:1,isUntitled:true,isDirty:!!p.content};if(method==='editor/applyWorkspaceEdit')return{applied:true};if(method==='workspace/saveDocument')return{saved:false};return null;}});
 await host.request('host/activate',{id:'test.unsaved'});
 const result=await host.request('host/executeCommand',{command:'unsaved'});
 assert.equal(result.untitled,true);assert.equal(result.language,'markdown');assert.equal(result.same,true);assert.equal(result.applied,true);assert.equal(result.saved,false);assert.notEqual(result.first,result.second);
 const batch=calls.find(c=>c.method==='editor/applyWorkspaceEdit');assert.equal(batch.p.files[0].path,result.first);
 assert.equal(calls.filter(c=>c.method==='workspace/createUntitled').length,2);
});

test('untitled creation enforces write permission and validates content options',async t=>{
 const host=await fixture(t,{'test.readunsaved':{permissions:['commands'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('readUnsaved',()=>v.workspace.openTextDocument({content:'x'}))`},'test.badunsaved':{permissions:['commands','workspaceWrite'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('badUnsaved',()=>v.workspace.openTextDocument({content:42}))`}});
 await host.request('host/activate',{id:'test.readunsaved'});await host.request('host/activate',{id:'test.badunsaved'});
 await assert.rejects(host.request('host/executeCommand',{command:'readUnsaved'}),/workspaceWrite/);
 await assert.rejects(host.request('host/executeCommand',{command:'badUnsaved'}),/content must be text/);
 assert.equal(host.messages.filter(m=>m.method==='workspace/createUntitled').length,0);
});
