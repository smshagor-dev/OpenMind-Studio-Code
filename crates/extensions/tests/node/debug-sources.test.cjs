'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('./rpc-fixture.cjs');
const command = (host, name, ...args) => host.request('host/executeCommand', {command:name,args});
const code = `const v=require('vscode'); let reads=0, hold=false, retained; const waiting=[]; const sessions=[];
exports.activate=()=>{
 v.debug.registerDebugAdapterDescriptorFactory('sources',{createDebugAdapterDescriptor(session){
 const emitter=new v.EventEmitter(); sessions.push(session);
 return new v.DebugAdapterInlineImplementation({onDidSendMessage:emitter.event,dispose(){emitter.dispose()},handleMessage(m){
 if(m.type!=='request')return;
 const reply=body=>queueMicrotask(()=>emitter.fire({seq:m.seq+100,type:'response',request_seq:m.seq,command:m.command,success:true,body:body||{}}));
 if(m.command==='initialize'){reply({});return;}
 if(m.command==='launch'){queueMicrotask(()=>emitter.fire({seq:999,type:'event',event:'initialized'}));reply();return;}
 if(m.command==='source'){reads++;const text=session.name+':'+m.arguments.source.adapterData.marker; const done=()=>reply({content:m.arguments.sourceReference===99?42:text,mimeType:'text/javascript'});if(hold)waiting.push(done);else done();return;}
 reply();
 }});}});
 v.commands.registerCommand('start',name=>v.debug.startDebugging(undefined,{type:'sources',request:'launch',name}));
 v.commands.registerCommand('uri',(index=0,ref=1)=>v.debug.asDebugSourceUri({name:'generated.js',sourceReference:ref,adapterData:{marker:'payload'}},sessions[index]).toString());
 v.commands.registerCommand('open',async uri=>{const [a,b]=await Promise.all([v.workspace.openTextDocument(v.Uri.parse(uri)),v.workspace.openTextDocument(v.Uri.parse(uri))]);retained=a;return{text:a.getText(),language:a.languageId,same:a===b,saved:await a.save(),reads};});
 v.commands.registerCommand('show',async uri=>{const editor=await v.window.showTextDocument(v.Uri.parse(uri));let edited;try{edited=await editor.edit(b=>b.insert(new v.Position(0,0),'write'))}catch(error){if(!/read-only/.test(error.message))throw error;edited=false}return{text:editor.document.getText(),edited};});
 v.commands.registerCommand('hold',()=>{hold=true;});
 v.commands.registerCommand('release',()=>{hold=false;waiting.splice(0).forEach(done=>done());});
 v.commands.registerCommand('stop',index=>v.debug.stopDebugging(sessions[index]));
 v.commands.registerCommand('state',()=>({reads,documents:v.workspace.textDocuments.map(d=>d.uri.toString()),retained:retained&&{text:retained.getText(),closed:retained.isClosed}}));
 v.commands.registerCommand('convert',source=>v.debug.asDebugSourceUri(source).toString());
};`;
async function setup(t) {
 const host=await fixture(t,{'test.sources':{code,permissions:['commands','processExecution','workspaceRead','workspaceWrite']}});
 await host.request('host/activate',{id:'test.sources'});return host;
}
test('debug source URIs load session-scoped read-only text, coalesce opens and preserve adapter data',async t=>{
 const host=await setup(t);await command(host,'start','First');const first=await command(host,'uri',0);
 assert.match(first,/^debug:\/\//);assert.match(first,/generated\.js\?ref=1$/);
 assert.deepEqual(await command(host,'open',first),{text:'First:payload',language:'javascript',same:true,saved:false,reads:1});
 await command(host,'start','Second');const second=await command(host,'uri',1);
 assert.notEqual(first,second);assert.equal((await command(host,'open',second)).text,'Second:payload');
 await command(host,'stop',0);
 assert.equal((await command(host,'open',first)).text,'First:payload');
 host.notify('host/documentClosed',{path:first});
 await assert.rejects(command(host,'open',first),/unavailable/);
 assert.equal((await command(host,'open',second)).text,'Second:payload');
});
test('closing a pending source settles its callers and a late adapter reply cannot restore it',async t=>{
 const host=await setup(t);await command(host,'start','Closing');const uri=await command(host,'uri');
 await command(host,'hold');const opening=command(host,'open',uri);const rejected=assert.rejects(opening,/cancelled/);
 await command(host,'state');host.notify('host/documentClosed',{path:uri});await rejected;
 await command(host,'release');assert.deepEqual((await command(host,'state')).documents,[]);
 assert.equal((await command(host,'open',uri)).text,'Closing:payload');
});
test('ending a source session cancels pending reads and rejects stale source URIs',async t=>{
 const host=await setup(t);await command(host,'start','Stopping');const uri=await command(host,'uri');
 await command(host,'hold');const opening=command(host,'open',uri);const rejected=assert.rejects(opening,/cancelled|unavailable|closed/);
 await command(host,'stop',0);await rejected;
 await assert.rejects(command(host,'open',uri),/unavailable/);
 assert.deepEqual((await command(host,'state')).documents,[]);
});
test('source conversion supports file paths and rejects malformed descriptors and references',async t=>{
 const host=await setup(t);
 assert.equal(await command(host,'convert',{path:'/tmp/source.js'}),'file:///tmp/source.js');
 for(const source of [null,{}, {sourceReference:1}, {sourceReference:1.5},{sourceReference:'1'}]) await assert.rejects(command(host,'convert',source),/source|session|reference/i);
 await command(host,'start','Validation');
 assert.match(await command(host,'convert',{name:'name?#.js',sourceReference:2}),/name%3F%23\.js/);
 await assert.rejects(command(host,'open','debug://unknown/source.js?ref=1'),/unavailable/);
});

test('malformed adapter source content fails without creating a document',async t=>{
 const host=await setup(t);await command(host,'start','Malformed');const uri=await command(host,'uri',0,99);
 await assert.rejects(command(host,'open',uri),/source text/);
 assert.deepEqual((await command(host,'state')).documents,[]);
 const good=await command(host,'uri');assert.equal((await command(host,'open',good)).text,'Malformed:payload');
});
test('debug source reads still require the reading extension workspaceRead permission',async t=>{
 const host=await fixture(t,{
  'test.sources':{code,permissions:['commands','processExecution','workspaceRead']},
  'test.reader':{permissions:['commands'],code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('reader.open',uri=>v.workspace.openTextDocument(v.Uri.parse(uri)));`},
 });
 await host.request('host/activate',{id:'test.sources'});await host.request('host/activate',{id:'test.reader'});
 await command(host,'start','Restricted');const uri=await command(host,'uri');
 await assert.rejects(command(host,'reader.open',uri),/workspaceRead/);
 assert.equal((await command(host,'state')).reads,0);
});

test('debug sources use the existing native read-only editor bridge and reject editor writes',async t=>{
 const calls=[];let host;
 host=await fixture(t,{'test.sources':{code,permissions:['commands','processExecution','workspaceRead','workspaceWrite']}},{handleRequest(method,p){
  calls.push({method,params:p});
  if(method==='workspace/openVirtualTextDocument')return{path:p.uri,text:p.text,version:p.version,languageId:p.languageId,native:true,virtual:true,readonly:true,isDirty:false};
  if(method==='ui/showTextDocument'){
   host.notify('host/editorSnapshot',{editors:[{id:'source-pane',path:p.path,viewColumn:1,selections:[],tabSize:4,insertSpaces:true}],activeId:'source-pane'});
   return{ok:true,editorId:'source-pane'};
  }
 }});
 await host.request('host/activate',{id:'test.sources'});await command(host,'start','Native');const uri=await command(host,'uri');
 assert.deepEqual(await command(host,'show',uri),{text:'Native:payload',edited:false});
 const opened=calls.find(c=>c.method==='workspace/openVirtualTextDocument');
 assert.equal(opened.params.readonly,true);assert.equal(opened.params.uri,uri);
 assert.equal(calls.some(c=>c.method==='editor/applyEdits'),false);
});
test('restored native debug buffers remain readable without reviving a terminated session',async t=>{
 const host=await setup(t),uri='debug://retired/generated.js?ref=1';
 host.notify('host/documentOpened',{path:uri,text:'Recovered source',version:4,languageId:'javascript',native:true,virtual:true,readonly:true});
 assert.equal((await command(host,'open',uri)).text,'Recovered source');
 assert.equal((await command(host,'state')).reads,0);
 host.notify('host/documentClosed',{path:uri});
 await assert.rejects(command(host,'open',uri),/unavailable/);
});
