'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('./rpc-fixture.cjs');
const code = `const v=require('vscode'); exports.activate=()=> {
 v.debug.registerDebugAdapterDescriptorFactory('reverse',{createDebugAdapterDescriptor(){
 const emitter=new v.EventEmitter(); let launch; return new v.DebugAdapterInlineImplementation({onDidSendMessage:emitter.event, dispose(){emitter.dispose()}, handleMessage(m){
 const reply=(body={})=>queueMicrotask(()=>emitter.fire({seq:m.seq+100,type:'response',request_seq:m.seq,command:m.command,success:true,body}));
 if(m.type==='response' && m.command==='runInTerminal') { if(!m.success) { emitter.fire({seq:99,type:'response',request_seq:launch.seq,command:'launch',success:false,message:m.message});return; } emitter.fire({seq:98,type:'response',request_seq:launch.seq,command:'launch',success:true,body:{}});return; }
 if(m.type!=='request')return;
 if(m.command==='initialize') {reply({supportsConfigurationDoneRequest:true});return;}
 if(m.command==='launch') {launch=m; queueMicrotask(()=>{emitter.fire({seq:51,type:'event',event:'initialized'});emitter.fire({seq:52,type:'request',command:'runInTerminal',arguments:{kind:'integrated',cwd:__dirname,args:['node','a b.js','$(literal)'],env:{TEST:'value',REMOVE:null}}})});return;}
 reply();
 }});}});
};`;
test('DAP reverse runInTerminal goes through owned integrated terminal request and is disposed on disconnect',async t=>{
 const requests=[];
 const host=await fixture(t,{'test.reverse':{code,permissions:['processExecution','terminal']}},{handleRequest(method,params){requests.push({method,params});return {};}});
 await host.request('host/activate',{id:'test.reverse'});
 assert.equal(await host.request('host/workbench',{domain:'debug',op:'start',configuration:{type:'reverse',request:'launch',name:'Reverse'}}),true);
 const launch=requests.find(x=>x.method==='terminal/runDebuggee');
 assert.deepEqual(launch.params.args,['node','a b.js','$(literal)']);assert.equal(launch.params.extension,'test.reverse');
 const snapshot=await host.request('host/workbench',{domain:'debug',op:'snapshot'});
 await host.request('host/workbench',{domain:'debug',op:'stop',session:snapshot.sessions[0].id});
 await host.request('host/workbench',{domain:'debug',op:'snapshot'});
 assert.ok(host.messages.some(x=>x.method==='terminal/dispose'&&x.params.id===launch.params.id));
});
test('DAP reverse launch refuses an adapter without terminal permission',async t=>{
 const host=await fixture(t,{'test.reverse':{code,permissions:['processExecution']}});
 await host.request('host/activate',{id:'test.reverse'});
 await assert.rejects(host.request('host/workbench',{domain:'debug',op:'start',configuration:{type:'reverse',request:'launch'}}),/terminal permission/);
 assert.equal(host.messages.some(x=>x.method==='terminal/runDebuggee'),false);
});
test('DAP startDebugging reverse requests launch a child configuration without blocking the parent',async t=>{
 const source=`const v=require('vscode');exports.activate=()=>v.debug.registerDebugAdapterDescriptorFactory('children',{createDebugAdapterDescriptor(session){const e=new v.EventEmitter();let launch;return new v.DebugAdapterInlineImplementation({onDidSendMessage:e.event,dispose(){e.dispose()},handleMessage(m){
 const reply=(message,body={})=>queueMicrotask(()=>e.fire({seq:88,type:'response',request_seq:message.seq,command:message.command,success:true,body}));
 if(m.type==='response'&&m.command==='startDebugging'){reply(launch);return;}
 if(m.type!=='request')return;
 if(m.command==='initialize'){reply(m,{supportsConfigurationDoneRequest:true});return;}
 if(m.command==='launch'){launch=m;queueMicrotask(()=>{e.fire({seq:41,type:'event',event:'initialized'});if(session.configuration.child)reply(m);else e.fire({seq:42,type:'request',command:'startDebugging',arguments:{request:'launch',configuration:{type:'children',child:true,name:'Child'}}})});return;}reply(m);
 }})}});`;
 const host=await fixture(t,{'test.children':{code:source,permissions:['processExecution']}});
 await host.request('host/activate',{id:'test.children'});
 assert.equal(await host.request('host/workbench',{domain:'debug',op:'start',configuration:{type:'children',request:'launch',name:'Parent'}}),true);
 const snapshot=await host.request('host/workbench',{domain:'debug',op:'snapshot'});assert.equal(snapshot.sessions.length,2);assert.ok(snapshot.sessions.some(s=>s.name==='Child'));
 await host.request('host/deactivate',{id:'test.children'});assert.equal((await host.request('host/workbench',{domain:'debug',op:'snapshot'})).sessions.length,0);
});
