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

test('named untitled URIs preserve encoded paths, reuse documents and infer associated targets without reads',async t=>{
 const calls=[];
 const host=await fixture(t,{'test.named':{permissions:['commands','workspaceWrite','filesystemOutsideWorkspace'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('named',async()=>{const uri=v.Uri.file('/tmp/named document.ts').with({scheme:'untitled'});const a=await v.workspace.openTextDocument(uri);const b=await v.workspace.openTextDocument(uri);const relative=await v.workspace.openTextDocument(v.Uri.parse('untitled:Draft'));return{same:a===b,scheme:a.uri.scheme,uri:a.uri.toString(),file:a.fileName,language:a.languageId,untitled:a.isUntitled,relative:relative.uri.toString(),relativeFile:relative.fileName}})`}}, {handleRequest(method,p){calls.push({method,p});if(method==='workspace/createUntitled')return{path:p.uri,text:'',languageId:'typescript',version:1,isUntitled:true,isDirty:true};throw Error('Unexpected filesystem call '+method);}});
 await host.request('host/activate',{id:'test.named'});
 const result=await host.request('host/executeCommand',{command:'named'});
 assert.deepEqual(result,{same:true,scheme:'untitled',uri:'untitled:///tmp/named%20document.ts',file:'/tmp/named document.ts',language:'typescript',untitled:true,relative:'untitled:Draft',relativeFile:'Draft'});
 assert.equal(calls.length,2);assert.equal(calls[0].p.associatedPath,'/tmp/named document.ts');assert.equal(calls[1].p.associatedPath,undefined);
});

test('named untitled creation enforces associated filesystem permissions and rejects reserved or ambiguous URIs',async t=>{
 const host=await fixture(t,{'test.nameddenied':{permissions:['commands','workspaceWrite'],code:`const v=require('vscode');exports.activate=()=>{v.commands.registerCommand('deniedNamed',()=>v.workspace.openTextDocument(v.Uri.file('/tmp/outside.ts').with({scheme:'untitled'})));v.commands.registerCommand('reservedNamed',()=>v.workspace.openTextDocument(v.Uri.parse('untitled://openmind/closed')));v.commands.registerCommand('queryNamed',()=>v.workspace.openTextDocument(v.Uri.parse('untitled:///tmp/file.ts?query')))}`}});
 await host.request('host/activate',{id:'test.nameddenied'});
 await assert.rejects(host.request('host/executeCommand',{command:'deniedNamed'}),/filesystemOutsideWorkspace/);
 await assert.rejects(host.request('host/executeCommand',{command:'reservedNamed'}),/Invalid or closed/);
 await assert.rejects(host.request('host/executeCommand',{command:'queryNamed'}),/Invalid or closed/);
 assert.equal(host.messages.filter(m=>m.method==='workspace/createUntitled').length,0);
});
