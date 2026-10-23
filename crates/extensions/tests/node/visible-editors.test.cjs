'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const{fixture}=require('./rpc-fixture.cjs');
const range=(end=2)=>({startLine:0,startColumn:0,endLine:end,endColumn:0});
const pane=(id,column,extra={})=>({id,path:'/tmp/shared.txt',viewColumn:column,selections:[{anchorLine:0,anchorColumn:0,activeLine:0,activeColumn:0}],tabSize:4,insertSpaces:true,visibleRanges:[range()],selectionKind:3,...extra});

test('visible split editors retain distinct identities, route actions and publish coherent lifecycle events',async t=>{
 const host=await fixture(t,{'test.panes':{permissions:['commands','workspaceWrite'],code:`const v=require('vscode');let first,second;const log=[],disposables=[],ctx={tag:'bound'};exports.activate=()=>{
 v.window.onDidChangeVisibleTextEditors(function(list){log.push(['visible',list.length,this.tag])},ctx,disposables);
 v.window.onDidChangeActiveTextEditor(e=>log.push(['active',e===first?'first':e===second?'second':'none']));
 v.window.onDidChangeTextEditorSelection(e=>log.push(['selection',e.textEditor===first,e.kind,e.selections[0].active.character]));
 v.window.onDidChangeTextEditorViewColumn(function(e){log.push(['column',e.textEditor===first,e.viewColumn,this.tag])},ctx);
 v.window.onDidChangeTextEditorVisibleRanges(function(e){log.push(['ranges',e.textEditor===first,e.visibleRanges[0].end.line,this.tag])},ctx);
 v.commands.registerCommand('inspect',()=>{[first,second]=v.window.visibleTextEditors;return{length:v.window.visibleTextEditors.length,distinct:first!==second,shared:first.document===second.document,columns:[first.viewColumn,second.viewColumn],active:v.window.activeTextEditor===first}});
 v.commands.registerCommand('act',()=>{first.selection=new v.Selection(0,1,0,2);first.revealRange(new v.Range(0,0,1,0));first.options.tabSize=2;return true});
 v.commands.registerCommand('read',()=>({log,firstColumn:first.viewColumn,range:first.visibleRanges[0]?.end.line}));
 v.commands.registerCommand('closed',async()=>({applied:await first.edit(b=>b.insert(new v.Position(0,0),'bad')),text:first.document.getText(),closed:first.document.isClosed}));
 v.commands.registerCommand('dispose',()=>{for(const d of disposables)d.dispose();return true});
 }`}});
 await host.request('host/activate',{id:'test.panes'});
 host.notify('host/documentOpened',{path:'/tmp/shared.txt',text:'abc\ndef\nghi',languageId:'plaintext',version:1,isDirty:false});
 host.notify('host/editorSnapshot',{editors:[pane('left',1),pane('right',2)],activeId:'left'});
 assert.deepEqual(await host.request('host/executeCommand',{command:'inspect'}),{length:2,distinct:true,shared:true,columns:[1,2],active:true});
 await host.request('host/executeCommand',{command:'act'});
 for(const method of ['editor/setSelections','editor/revealRange','editor/setOptions'])assert.equal(host.messages.find(m=>m.method===method).params.editorId,'left');
 const moved=pane('left',3,{selections:[{anchorLine:0,anchorColumn:1,activeLine:0,activeColumn:2}],visibleRanges:[range(1)],selectionKind:1});
 host.notify('host/editorSnapshot',{editors:[pane('right',1),moved],activeId:'right'});
 const read=await host.request('host/executeCommand',{command:'read'});
 assert.equal(read.firstColumn,3);assert.equal(read.range,1);
 assert.ok(read.log.some(e=>JSON.stringify(e)===JSON.stringify(['selection',true,1,2])),'setter acknowledgement must still emit the selection event');
 assert.ok(read.log.some(e=>JSON.stringify(e)===JSON.stringify(['ranges',true,1,'bound'])));
 assert.ok(read.log.some(e=>JSON.stringify(e)===JSON.stringify(['column',true,3,'bound'])));
 assert.equal(read.log.filter(e=>e[0]==='visible').length,2,'pane reordering publishes visible order');
 assert.ok(read.log.some(e=>JSON.stringify(e)===JSON.stringify(['active','second'])));
 await host.request('host/executeCommand',{command:'dispose'});
 host.notify('host/editorSnapshot',{editors:[pane('right',1)],activeId:'right'});
 host.notify('host/editorSnapshot',{editors:[],activeId:null});
 host.notify('host/documentChanged',{path:'/tmp/shared.txt',text:'latest retained text',version:2,isDirty:true});
 host.notify('host/documentClosed',{path:'/tmp/shared.txt'});
 assert.deepEqual(await host.request('host/executeCommand',{command:'closed'}),{applied:false,text:'latest retained text',closed:true});
 const final=await host.request('host/executeCommand',{command:'read'});assert.equal(final.log.filter(e=>e[0]==='visible').length,2);
 assert.equal(host.messages.filter(m=>m.method==='editor/applyEdits').length,0);
});

test('host initialization exposes both visible editors before extension activation',async t=>{
 const host=await fixture(t,{'test.initial':{permissions:['commands'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('initial',()=>({columns:v.window.visibleTextEditors.map(e=>e.viewColumn),same:v.window.activeTextEditor===v.window.visibleTextEditors[1]}))`}});
 const editors=[pane('a',1),pane('b',2)];
 await host.request('host/init',{extensions:host.extensions,documents:[{path:'/tmp/shared.txt',text:'abc',languageId:'plaintext',version:1,isDirty:false}],activeEditor:editors[1],visibleEditors:editors});
 await host.request('host/activate',{id:'test.initial'});
 assert.deepEqual(await host.request('host/executeCommand',{command:'initial'}),{columns:[1,2],same:true});
});

test('temporarily covered editors keep identity when visible again and unchanged snapshots emit no duplicate events',async t=>{
 const host=await fixture(t,{'test.covered':{permissions:['commands'],code:`const v=require('vscode');let saved,changes=0;exports.activate=()=>{v.window.onDidChangeVisibleTextEditors(()=>changes++);v.commands.registerCommand('save',()=>{saved=v.window.visibleTextEditors[0];return true});v.commands.registerCommand('same',()=>({same:saved===v.window.visibleTextEditors[0],changes}))}`}});
 await host.request('host/activate',{id:'test.covered'});
 host.notify('host/documentOpened',{path:'/tmp/shared.txt',text:'abc',languageId:'plaintext',version:1,isDirty:false});
 const editors=[pane('stable',1)];host.notify('host/editorSnapshot',{editors,activeId:'stable'});
 await host.request('host/executeCommand',{command:'save'});
 host.notify('host/editorSnapshot',{editors:[],activeId:null});
 host.notify('host/editorSnapshot',{editors,activeId:'stable'});host.notify('host/editorSnapshot',{editors,activeId:'stable'});
 assert.deepEqual(await host.request('host/executeCommand',{command:'same'}),{same:true,changes:3});
});

test('showTextDocument waits for the requested visible editor rather than returning the previous active pane',async t=>{
 let host;host=await fixture(t,{'test.show':{permissions:['commands','workspaceRead'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('show',async()=>{const doc=v.workspace.textDocuments.find(d=>d.fileName==='/tmp/new.txt');const editor=await v.window.showTextDocument(doc);return{path:editor.document.fileName,same:editor===v.window.visibleTextEditors[0]}})`}}, {handleRequest(method){if(method==='ui/showTextDocument')setTimeout(()=>host.notify('host/editorSnapshot',{editors:[{...pane('new',1),path:'/tmp/new.txt'}],activeId:'new'}),30);return{ok:true}}});
 await host.request('host/activate',{id:'test.show'});
 for(const path of ['/tmp/shared.txt','/tmp/new.txt'])host.notify('host/documentOpened',{path,text:'abc',languageId:'plaintext',version:1,isDirty:false});
 host.notify('host/editorSnapshot',{editors:[pane('old',1)],activeId:'old'});
 assert.deepEqual(await host.request('host/executeCommand',{command:'show'}),{path:'/tmp/new.txt',same:true});
});

test('extension teardown cancels showTextDocument while the UI request remains unanswered',async t=>{
 let begin;const started=new Promise(resolve=>{begin=resolve});
 const host=await fixture(t,{'test.pending':{permissions:['commands','workspaceRead'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('pending',()=>v.window.showTextDocument(v.workspace.textDocuments[0]))`}}, {handleRequest(method){if(method==='ui/showTextDocument'){begin();return new Promise(()=>{});}return{ok:true}}});
 await host.request('host/activate',{id:'test.pending'});
 host.notify('host/documentOpened',{path:'/tmp/new.txt',text:'abc',languageId:'plaintext',version:1,isDirty:false});
 host.notify('host/editorSnapshot',{editors:[],activeId:null});
 const request=host.request('host/executeCommand',{command:'pending'});const rejected=assert.rejects(request,/stopped before its editor became visible/);
 await started;await host.request('host/deactivate',{id:'test.pending'});await rejected;
 const show=host.messages.find(m=>m.method==='ui/showTextDocument');
 const cancel=host.messages.find(m=>m.method==='ui/cancelShowTextDocument');
 assert.equal(cancel.params.extension,'test.pending');assert.equal(cancel.params.requestId,show.params.requestId);
});

test('the host bundle embedded by Rust includes the new lifecycle module and runs outside the source tree',async t=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const bundle=fs.mkdtempSync(path.join(os.tmpdir(),'openmind-host-bundle-'));
 const rustPath=path.resolve(__dirname,'../../src/host.rs'),rust=fs.readFileSync(rustPath,'utf8');
 const sources=new Map([...rust.matchAll(/const (\w+): &str = include_str!\("([^"]+)"\);/g)].map(match=>[match[1],path.resolve(path.dirname(rustPath),match[2])]));
 const manifest=rust.slice(rust.indexOf('fn write_host_files'));
 for(const entry of manifest.matchAll(/\("([^"]+\.js)", (\w+)\)/g))fs.copyFileSync(sources.get(entry[2]),path.join(bundle,entry[1]));
 assert.ok(fs.existsSync(path.join(bundle,'editorstate.js')));
 const host=await fixture(t,{'test.bundle':{permissions:['commands'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('bundle',()=>v.window.visibleTextEditors.map(e=>e.viewColumn))`}}, {hostPath:path.join(bundle,'host.js')});
 t.after(()=>fs.rmSync(bundle,{recursive:true,force:true}));
 await host.request('host/activate',{id:'test.bundle'});
 host.notify('host/documentOpened',{path:'/tmp/shared.txt',text:'abc',languageId:'plaintext',version:1,isDirty:false});
 host.notify('host/editorSnapshot',{editors:[pane('bundle-left',1),pane('bundle-right',2)],activeId:'bundle-right'});
 assert.deepEqual(await host.request('host/executeCommand',{command:'bundle'}),[1,2]);
});
