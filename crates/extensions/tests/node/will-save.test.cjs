'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {fixture}=require('./rpc-fixture.cjs');
const file='/workspace/save.txt';const document={path:file,text:'body',version:1,languageId:'plaintext',isDirty:true};
async function setup(t,body,permissions=['commands','workspaceRead','workspaceWrite']){
 const h=await fixture(t,{'test.save':{permissions,code:`const v=require('vscode');exports.activate=()=>{${body}};`}});
 h.notify('host/documentOpened',document);await h.request('host/activate',{id:'test.save'});return h;
}
const saving=(h,reason=1,version=1)=>h.request('host/willSaveDocument',{path:file,reason,version});
const command=(h,command)=>h.request('host/executeCommand',{command});
test('save listeners run sequentially and prepare permission-checked edits without applying them',async t=>{
 const h=await setup(t,`const order=[];v.workspace.onWillSaveTextDocument(function(e){order.push(this.name+e.reason);e.waitUntil(Promise.resolve([v.TextEdit.insert(new v.Position(0,0),'pre:')]));},{name:'first'});v.workspace.onWillSaveTextDocument(e=>{order.push('second');e.waitUntil(Promise.resolve([v.TextEdit.setEndOfLine(v.EndOfLine.CRLF)]));});v.commands.registerCommand('order',()=>order);`);
 const result=await saving(h,3);assert.equal(result.files.length,2);assert.deepEqual(result.files[0],{path:file,version:1,edits:[{startLine:0,startColumn:0,endLine:0,endColumn:0,text:'pre:'}]});assert.equal(result.files[1].eol,2);assert.deepEqual(await command(h,'order'),['first3','second']);assert.equal(h.messages.some(m=>m.method==='editor/applyWorkspaceEdit'),false);
});
test('delay-only promises need no write permission and late waitUntil rejects',async t=>{
 const h=await setup(t,`let message='';v.workspace.onWillSaveTextDocument(e=>{e.waitUntil(Promise.resolve(42));Promise.resolve().then(()=>{try{e.waitUntil(Promise.resolve())}catch(error){message=error.message}});});v.commands.registerCommand('late',()=>message);`,['commands','workspaceRead']);
 assert.deepEqual(await saving(h),{files:[]});assert.match(await command(h,'late'),/during save event delivery/);
});
test('listeners without write permission cannot return edits, and repeated failures are disabled',async t=>{
 const h=await setup(t,`let calls=0;v.workspace.onWillSaveTextDocument(e=>{calls++;e.waitUntil(Promise.resolve([v.TextEdit.insert(new v.Position(0,0),'x')]));});v.commands.registerCommand('calls',()=>calls);`,['commands','workspaceRead']);
 for(let i=0;i<4;i++)assert.deepEqual(await saving(h),{files:[]});assert.equal(await command(h,'calls'),3);
});
test('edits are discarded after concurrent document changes or listener disposal',async t=>{
 const h=await setup(t,`let release;const items=[];v.workspace.onWillSaveTextDocument(e=>e.waitUntil(new Promise(done=>release=()=>done([v.TextEdit.insert(new v.Position(0,0),'old')]))),undefined,items);v.commands.registerCommand('release',()=>release());v.commands.registerCommand('dispose',()=>items[0].dispose());`);
 const pending=saving(h);await new Promise(r=>setTimeout(r,20));h.notify('host/documentChanged',{...document,text:'new',version:2});await command(h,'release');assert.deepEqual(await pending,{files:[]});
 const second=saving(h,1,2);await new Promise(r=>setTimeout(r,20));await command(h,'dispose');await command(h,'release');assert.deepEqual(await second,{files:[]});
});
test('the shared save budget ends waiting and a late listener reply cannot apply edits',async t=>{
 const h=await setup(t,`let release;v.workspace.onWillSaveTextDocument(e=>e.waitUntil(new Promise(done=>release=()=>done([v.TextEdit.insert(new v.Position(0,0),'late')]))));v.commands.registerCommand('release',()=>release());`);
 assert.deepEqual(await saving(h),{files:[]});await command(h,'release');assert.equal(h.messages.some(m=>m.method==='editor/applyWorkspaceEdit'),false);
});
test('deactivation removes listeners and stale versions are not delivered',async t=>{
 const h=await setup(t,`let calls=0;v.workspace.onWillSaveTextDocument(()=>calls++);v.commands.registerCommand('calls',()=>calls);`);assert.deepEqual(await saving(h,1,99),{files:[]});assert.equal(await command(h,'calls'),0);await h.request('host/deactivate',{id:'test.save'});assert.deepEqual(await saving(h),{files:[]});await assert.rejects(saving(h,99),/Invalid save reason/);
});
