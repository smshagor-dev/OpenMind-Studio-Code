'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./rpc-fixture.cjs');

test('editor edits carry EOL and undo options, expire builders and preserve workspace EOL edits', async t => {
 const calls=[];
 const host=await fixture(t,{'test.edit':{permissions:['commands','workspaceWrite'],code:`const v=require('vscode');exports.activate=()=>{
 v.commands.registerCommand('edit',async()=>{const editor=v.window.activeTextEditor;let builder;const result=await editor.edit(b=>{builder=b;b.setEndOfLine(v.EndOfLine.CRLF)},{undoStopBefore:false,undoStopAfter:false});let expired=false;try{builder.insert(new v.Position(0,0),'late')}catch{expired=true}return{result,expired,eol:editor.document.eol}});
 v.commands.registerCommand('workspace',async()=>{const e=new v.WorkspaceEdit(),u=v.window.activeTextEditor.document.uri;e.set(u,[v.TextEdit.setEndOfLine(v.EndOfLine.LF)]);const got=e.get(u)[0].newEol;return{applied:await v.workspace.applyEdit(e),got}});
 v.commands.registerCommand('throw',async()=>{let builder;try{await v.window.activeTextEditor.edit(b=>{builder=b;throw Error('callback')})}catch{};try{builder.setEndOfLine(1);return false}catch{return true}});
 }`}}, {handleRequest(method,params){calls.push({method,params});return{applied:true}}});
 await host.request('host/activate',{id:'test.edit'});
 host.notify('host/documentOpened',{path:'/tmp/editor.txt',text:'one line',languageId:'plaintext',version:1,isDirty:false,eol:2});
 host.notify('host/activeEditorChanged',{editor:{path:'/tmp/editor.txt',selections:[],tabSize:4,insertSpaces:true}});
 assert.deepEqual(await host.request('host/executeCommand',{command:'edit'}),{result:true,expired:true,eol:2});
 assert.deepEqual(calls[0],{method:'editor/applyEdits',params:{extension:'test.edit',path:'/tmp/editor.txt',version:1,edits:[],eol:2,undoStopBefore:false,undoStopAfter:false}});
 assert.deepEqual(await host.request('host/executeCommand',{command:'workspace'}),{applied:true,got:1});
 assert.equal(calls[1].params.files[0].eol,1);assert.deepEqual(calls[1].params.files[0].edits,[]);
 assert.equal(await host.request('host/executeCommand',{command:'throw'}),true);assert.equal(calls.length,2);
});

test('TextEditor.edit requires workspaceWrite before calling extension edit code',async t=>{
 const host=await fixture(t,{'test.read':{permissions:['commands'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('attempt',()=>v.window.activeTextEditor.edit(()=>{throw Error('callback must not run')}))`}});
 await host.request('host/activate',{id:'test.read'});
 host.notify('host/documentOpened',{path:'/tmp/read.txt',text:'read only',languageId:'plaintext',version:1,isDirty:false});
 host.notify('host/activeEditorChanged',{editor:{path:'/tmp/read.txt',selections:[]}});
 await assert.rejects(host.request('host/executeCommand',{command:'attempt'}),/workspaceWrite/);
 assert.equal(host.messages.filter(m=>m.method==='editor/applyEdits').length,0);
});

test('editor option setters route live updates and option change events keep editor identity and thisArg',async t=>{
 const host=await fixture(t,{'test.options':{permissions:['commands'],code:`const v=require('vscode');let event,editor,context={marker:'context'};exports.activate=()=>{
 v.window.onDidChangeTextEditorOptions(function(e){event={same:e.textEditor===editor,tabSize:e.options.tabSize,marker:this.marker}},context);
 v.commands.registerCommand('options',()=>{editor=v.window.activeTextEditor;editor.options={tabSize:2,insertSpaces:false};editor.options.tabSize='auto';let invalid=false;try{editor.options.tabSize=0}catch{invalid=true}return invalid});
 v.commands.registerCommand('check',()=>({event,options:{...editor.options}}));}`}});
 await host.request('host/activate',{id:'test.options'});
 host.notify('host/documentOpened',{path:'/tmp/options.txt',text:'one',languageId:'plaintext',version:1,isDirty:false});
 host.notify('host/activeEditorChanged',{editor:{path:'/tmp/options.txt',selections:[],tabSize:4,insertSpaces:true}});
 assert.equal(await host.request('host/executeCommand',{command:'options'}),true);
 const updates=host.messages.filter(m=>m.method==='editor/setOptions');assert.equal(updates.length,2);assert.deepEqual(updates[0].params.options,{tabSize:2,insertSpaces:false});assert.deepEqual(updates[1].params.options,{tabSize:'auto'});
 host.notify('host/editorOptionsChanged',{path:'/tmp/options.txt',tabSize:2,insertSpaces:false});
 assert.deepEqual(await host.request('host/executeCommand',{command:'check'}),{event:{same:true,tabSize:2,marker:'context'},options:{tabSize:2,indentSize:2,insertSpaces:false,cursorStyle:1,lineNumbers:1}});
});

test('snippet insertion routes positions, ranges, defaults and undo flags through the real host', async t => {
 const calls=[];
 const host=await fixture(t,{'test.snippets':{permissions:['commands','workspaceWrite'],code:`const v=require('vscode');let saved;exports.activate=()=>{
 v.commands.registerCommand('snippet',async(kind)=>{const e=v.window.activeTextEditor;saved=e;const s=new v.SnippetString().appendPlaceholder('name').appendText('=').appendTabstop(1);const location=kind==='default'?undefined:kind==='invalid'?{line:-1,character:0}:[new v.Position(0,0),new v.Range(0,2,0,4)];return e.insertSnippet(s,location,{undoStopBefore:false,undoStopAfter:false})});
 v.commands.registerCommand('nestedSnippet',()=>new v.SnippetString().appendPlaceholder(b=>{b.appendPlaceholder('inner')}).appendVariable('NAME',b=>{b.appendPlaceholder('fallback')}).appendVariable('TM_FILENAME').appendTabstop().value);
 v.commands.registerCommand('retainedSnippet',()=>saved.insertSnippet(new v.SnippetString('late')));
 }`}}, {handleRequest(method,params){calls.push({method,params});return{applied:calls.length===1}}});
 await host.request('host/activate',{id:'test.snippets'});
 host.notify('host/documentOpened',{path:'/tmp/snippet.txt',text:'some text',languageId:'plaintext',version:7,isDirty:false});
 const editor={id:'pane',path:'/tmp/snippet.txt',selections:[],tabSize:4,insertSpaces:true};
 host.notify('host/editorSnapshot',{editors:[editor],activeId:'pane'});
 assert.equal(await host.request('host/executeCommand',{command:'snippet'}),true);
 assert.deepEqual(calls[0],{method:'editor/insertSnippet',params:{extension:'test.snippets',path:'/tmp/snippet.txt',editorId:'pane',version:7,snippet:'${1:name}=$1',ranges:[{startLine:0,startColumn:0,endLine:0,endColumn:0},{startLine:0,startColumn:2,endLine:0,endColumn:4}],undoStopBefore:false,undoStopAfter:false}});
 assert.equal(await host.request('host/executeCommand',{command:'snippet',args:['default']}),false);
 assert.equal(calls[1].params.ranges,undefined);
 await assert.rejects(host.request('host/executeCommand',{command:'snippet',args:['invalid']}),/Position or Range/);
 assert.equal(calls.length,2);
 assert.equal(await host.request('host/executeCommand',{command:'nestedSnippet'}),'${1:${2:inner}}${NAME:${3:fallback}}${TM_FILENAME}$4');
 host.notify('host/editorSnapshot',{editors:[],activeId:null});
 assert.equal(await host.request('host/executeCommand',{command:'retainedSnippet'}),false);
 assert.equal(calls.length,2);
});

test('snippet insertion requires workspaceWrite',async t=>{
 const host=await fixture(t,{'test.readsnippet':{permissions:['commands'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('attemptSnippet',()=>v.window.activeTextEditor.insertSnippet(new v.SnippetString('write')))`}});
 await host.request('host/activate',{id:'test.readsnippet'});
 host.notify('host/documentOpened',{path:'/tmp/read.txt',text:'read',languageId:'plaintext',version:1,isDirty:false});
 host.notify('host/activeEditorChanged',{editor:{path:'/tmp/read.txt',selections:[]}});
 await assert.rejects(host.request('host/executeCommand',{command:'attemptSnippet'}),/workspaceWrite/);
 assert.equal(host.messages.filter(m=>m.method==='editor/insertSnippet').length,0);
});


test('all text editor options target a split pane and report resolved changes without cursor movement', async t => {
 const host = await fixture(t, {'test.options': { permissions: ['commands'], code: `
 const v = require('vscode'); const events = [];
 exports.activate = () => {
  v.window.onDidChangeTextEditorOptions(event => events.push({ id: event.textEditor.document.uri.toString(), options: event.options, live: {...event.textEditor.options} }));
  v.commands.registerCommand('set', value => { v.window.visibleTextEditors[1].options = value; });
  v.commands.registerCommand('get', () => ({ editors: v.window.visibleTextEditors.map(e => ({...e.options})), events }));
 };`}});
 await host.request('host/activate', {id: 'test.options'});
 const path = '/tmp/panes.txt';
 host.notify('host/documentOpened', {path, text: 'text', languageId: 'plaintext', version: 1});
 const left = {id:'left',path,tabSize:4,indentSize:2,insertSpaces:true,cursorStyle:1,lineNumbers:1,selections:[]};
 const right = {...left,id:'right'};
 host.notify('host/editorSnapshot', {editors:[left,right],activeId:'left'});
 const options = {tabSize:8,indentSize:'tabSize',insertSpaces:'auto',cursorStyle:6,lineNumbers:2};
 await host.request('host/executeCommand', {command:'set',args:[options]});
 const update = host.messages.find(m => m.method === 'editor/setOptions');
 assert.equal(update.params.editorId,'right'); assert.deepEqual(update.params.options,options);
 for (const invalid of [{indentSize:'auto'},{indentSize:0},{cursorStyle:0},{cursorStyle:7},{lineNumbers:3},{lineNumbers:1.5},{tabSize:8,cursorStyle:NaN},{unknown:1}]) {
  await assert.rejects(host.request('host/executeCommand',{command:'set',args:[invalid]}),/Invalid|Unsupported/);
 }
 assert.equal(host.messages.filter(m=>m.method==='editor/setOptions').length,1);
 host.notify('host/editorSnapshot',{editors:[left,{...right,tabSize:8,indentSize:8,cursorStyle:6,lineNumbers:2}],activeId:'left'});
 const value = await host.request('host/executeCommand',{command:'get'});
 assert.deepEqual(value.editors[0],{tabSize:4,indentSize:2,insertSpaces:true,cursorStyle:1,lineNumbers:1});
 assert.deepEqual(value.editors[1],{tabSize:8,indentSize:8,insertSpaces:true,cursorStyle:6,lineNumbers:2});
 assert.equal(value.events.length,1); assert.deepEqual(value.events[0].options,value.editors[1]);
 assert.deepEqual(value.events[0].live,value.editors[1]);
 host.notify('host/editorSnapshot',{editors:[left,{...right,tabSize:8,indentSize:8,cursorStyle:6,lineNumbers:2}],activeId:'left'});
 assert.equal((await host.request('host/executeCommand',{command:'get'})).events.length,1);
 const visualOnly = {...right,tabSize:8,indentSize:8,cursorStyle:5,lineNumbers:0};
 host.notify('host/editorSnapshot',{editors:[left,visualOnly],activeId:'left'});
 const visual = await host.request('host/executeCommand',{command:'get'});
 assert.equal(visual.events.length,2);
 assert.deepEqual(visual.events[1].options,{tabSize:8,indentSize:8,insertSpaces:true,cursorStyle:5,lineNumbers:0});
 host.notify('host/editorSnapshot',{editors:[left,{...visualOnly,indentSize:3}],activeId:'left'});
 const indentation = await host.request('host/executeCommand',{command:'get'});
 assert.equal(indentation.events.length,3);
 assert.deepEqual(indentation.events[2].options,{tabSize:8,indentSize:3,insertSpaces:true,cursorStyle:5,lineNumbers:0});
});
