'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./rpc-fixture.cjs');
const code=`const v=require('vscode');let terminal,initial,events=[];exports.activate=()=>{v.window.onDidOpenTerminal(t=>events.push(['open',t.name]));v.window.onDidChangeActiveTerminal(function(t){events.push(['active',t?.name||null,this.name]);},{name:'bound'});v.window.onDidChangeTerminalState(t=>events.push(['state',t===terminal,t.state.isInteractedWith]));v.commands.registerCommand('create',async()=>{terminal=v.window.createTerminal('Build');initial=terminal.state;await terminal.processId;return true;});v.commands.registerCommand('inspect',()=>({active:v.window.activeTerminal?.name||null,interacted:terminal?.state.isInteractedWith,initial:initial?.isInteractedWith,frozen:terminal?Object.isFrozen(terminal.state):true,events}));v.commands.registerCommand('dispose',()=>terminal.dispose());};`;
async function setup(t){const h=await fixture(t,{'test.term':{permissions:['commands','terminal'],code},'test.other':{permissions:['commands','terminal'],code:code.replaceAll("'create'","'other.create'").replaceAll("'inspect'","'other.inspect'").replaceAll("'dispose'","'other.dispose'")}},{handleRequest:async method=>method==='terminal/create'?{pid:1}:null});await h.request('host/activate',{id:'test.term'});return h;}
const command=(h,command)=>h.request('host/executeCommand',{command});
const id=h=>h.messages.find(m=>m.method==='terminal/create').params.id;
test('active terminal events preserve terminal identity, context and clear on close',async t=>{
 const h=await setup(t);await command(h,'create');h.notify('host/activeTerminalChanged',{id:id(h)});h.notify('host/activeTerminalChanged',{id:id(h)});
 assert.deepEqual((await command(h,'inspect')).events,[['open','Build'],['active','Build','bound']]);await command(h,'dispose');assert.equal((await command(h,'inspect')).active,null);
});
test('interaction snapshots are immutable, monotonic and deduplicated',async t=>{
 const h=await setup(t);await command(h,'create');for(const value of [false,true,true,false])h.notify('host/terminalStateChanged',{id:id(h),isInteractedWith:value});const s=await command(h,'inspect');assert.equal(s.interacted,true);assert.equal(s.initial,false);assert.equal(s.frozen,true);assert.deepEqual(s.events.filter(e=>e[0]==='state'),[['state',true,true]]);
});
test('another extension cannot obtain or receive state events for an owned terminal',async t=>{
 const h=await setup(t);await command(h,'create');await h.request('host/activate',{id:'test.other'});h.notify('host/activeTerminalChanged',{id:id(h)});h.notify('host/terminalStateChanged',{id:id(h),isInteractedWith:true});const s=await command(h,'other.inspect');assert.equal(s.active,null);assert.deepEqual(s.events,[]);
});
test('selection before terminal creation completes is delivered after the open event',async t=>{
 let release;let h;const gate=new Promise(resolve=>release=resolve);
 h=await fixture(t,{'test.term':{permissions:['commands','terminal'],code}},{handleRequest:async method=>{if(method==='terminal/create'){await gate;return {pid:1};}}});await h.request('host/activate',{id:'test.term'});const creating=command(h,'create');
 for(let i=0;i<100&&!h.messages.some(m=>m.method==='terminal/create');i++)await new Promise(r=>setTimeout(r,5));
 h.notify('host/activeTerminalChanged',{id:id(h)});h.notify('host/terminalStateChanged',{id:id(h),isInteractedWith:true});release();await creating;
 assert.deepEqual((await command(h,'inspect')).events,[['open','Build'],['active','Build','bound'],['state',true,true]]);
});

test('closing from open or active callbacks suppresses queued interaction events',async t=>{
 for(const closeOn of ['open','active']){
  let release;const gate=new Promise(resolve=>release=resolve);let h;
  const extensionCode=`const v=require('vscode');const events=[];let terminal;exports.activate=()=>{v.window.onDidOpenTerminal(t=>{events.push('open');if('${closeOn}'==='open')t.dispose();});v.window.onDidChangeActiveTerminal(t=>{if(!t)return;events.push('active');if('${closeOn}'==='active')t.dispose();});v.window.onDidCloseTerminal(()=>events.push('close'));v.window.onDidChangeTerminalState(()=>events.push('state'));v.commands.registerCommand('create',async()=>{terminal=v.window.createTerminal('Build');await terminal.processId;});v.commands.registerCommand('inspect',()=>events);};`;
  h=await fixture(t,{'test.term':{permissions:['commands','terminal'],code:extensionCode}},{handleRequest:async method=>{if(method==='terminal/create'){await gate;return {pid:1};}}});await h.request('host/activate',{id:'test.term'});const creating=command(h,'create');
  for(let i=0;i<100&&!h.messages.some(m=>m.method==='terminal/create');i++)await new Promise(r=>setTimeout(r,5));
  h.notify('host/activeTerminalChanged',{id:id(h)});h.notify('host/terminalStateChanged',{id:id(h),isInteractedWith:true});release();await creating;
  assert.deepEqual(await command(h,'inspect'),closeOn==='open'?['open','close']:['open','active','close']);
 }
});
