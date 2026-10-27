'use strict';
const { normalize } = require('node:path');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./rpc-fixture.cjs');
const command=(host,name,...args)=>host.request('host/executeCommand',{command:name,args});
async function setup(t){
 const host=await fixture(t,{'test.folders':{code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('pick',async options=>{const value=await v.window.showWorkspaceFolderPick(options);return value?{name:value.name,index:value.index,path:value.uri.fsPath,uri:value.uri.toString()}:null;});`}});
 await host.request('host/activate',{id:'test.folders'});return host;
}
const folders=[{path:normalize('/workspace/one'),name:'Project'},{path:normalize('/workspace/two'),name:'Project'}];
function prepare(host,value=folders){host.notify('host/workspaceFoldersChanged',{folders:value});}
async function shown(host){
 for(let i=0;i<100;i++){const pick=host.messages.filter(m=>m.method==='quickInput/set'&&m.params.visible).at(-1)?.params;if(pick)return pick;await new Promise(r=>setTimeout(r,5));}
 throw Error('Workspace picker was not shown');
}
const event=(host,pick,name,items)=>host.request('host/quickInputEvent',{id:pick.id,event:name,items});
test('workspace folder picker displays names and paths and returns a typed folder by item identity',async t=>{
 const host=await setup(t);prepare(host);const opening=command(host,'pick',{placeHolder:'Pick a folder',ignoreFocusOut:true});const pick=await shown(host);
 assert.equal(pick.placeholder,'Pick a folder');assert.equal(pick.ignoreFocusOut,true);assert.equal(pick.matchOnDescription,true);
 assert.deepEqual(pick.items.map(i=>({label:i.label,description:i.description})),folders.map(f=>({label:f.name,description:f.path})));
 assert.ok(pick.items.every(i=>!Object.hasOwn(i,'folder')));
 await event(host,pick,'selection',[pick.items[1].id]);await event(host,pick,'accept');
 assert.deepEqual(await opening,{name:'Project',index:1,path:normalize('/workspace/two'),uri:'file:///workspace/two'});
 assert.ok(host.messages.some(m=>m.method==='quickInput/set'&&m.params.id===pick.id&&m.params.visible===false));
});
test('workspace folder picker settles cancellation and ignores events after disposal',async t=>{
 const host=await setup(t);prepare(host);const opening=command(host,'pick');const pick=await shown(host);
 await event(host,pick,'hide');assert.equal(await opening,null);
 await event(host,pick,'selection',[pick.items[0].id]);await event(host,pick,'accept');
});
test('workspace changes cancel the pending folder selection rather than returning a removed folder',async t=>{
 const host=await setup(t);prepare(host);const opening=command(host,'pick');const pick=await shown(host);
 prepare(host,[{path:normalize('/workspace/new'),name:'New'}]);assert.equal(await opening,null);
 await event(host,pick,'selection',[pick.items[0].id]);await event(host,pick,'accept');
});
test('extension deactivation settles a pending workspace folder picker',async t=>{
 const host=await setup(t);prepare(host);const opening=command(host,'pick');await shown(host);
 await host.request('host/deactivate',{id:'test.folders'});assert.equal(await opening,null);
});
test('empty workspaces return no folder without displaying a picker',async t=>{
 const host=await setup(t);prepare(host,[]);assert.equal(await command(host,'pick'),null);
 assert.equal(host.messages.some(m=>m.method==='quickInput/set'),false);
});
test('malformed picker options reject without creating UI',async t=>{
 const host=await setup(t);prepare(host);
 for(const value of [null,[],{placeHolder:42},{ignoreFocusOut:'true'}])await assert.rejects(command(host,'pick',value),/must be/);
 assert.equal(host.messages.some(m=>m.method==='quickInput/set'),false);
});
