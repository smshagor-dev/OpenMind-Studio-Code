'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./rpc-fixture.cjs');
const code=`const v=require('vscode');let events=[],first,subscription;exports.activate=()=>{first=v.window.state;subscription=v.window.onDidChangeWindowState(function(s){events.push({focused:s.focused,context:this.name,same:s===v.window.state});},{name:'bound'});v.commands.registerCommand('state',()=>({focused:v.window.state.focused,initial:first.focused,events,frozen:Object.isFrozen(v.window.state)}));v.commands.registerCommand('dispose',()=>subscription.dispose());};`;
async function setup(t,focused){const h=await fixture(t,{'test.focus':{code}});await h.request('host/init',{windowState:{focused}});await h.request('host/activate',{id:'test.focus'});return h;}
const state=h=>h.request('host/executeCommand',{command:'state'});
test('window state is seeded before activation and exposes immutable snapshots without permissions',async t=>{
 const h=await setup(t,true);assert.deepEqual(await state(h),{focused:true,initial:true,events:[],frozen:true});
 h.notify('host/windowStateChanged',{focused:false});
 assert.deepEqual(await state(h),{focused:false,initial:true,events:[{focused:false,context:'bound',same:true}],frozen:true});
});
test('duplicate and malformed window focus updates do not fire events',async t=>{
 const h=await setup(t,false);for(const focused of [false,'true',null,1])h.notify('host/windowStateChanged',{focused});
 assert.deepEqual((await state(h)).events,[]);h.notify('host/windowStateChanged',{focused:true});h.notify('host/windowStateChanged',{focused:true});assert.equal((await state(h)).events.length,1);
});
test('disposed focus subscriptions stop receiving changes while the current state stays live',async t=>{
 const h=await setup(t,true);await h.request('host/executeCommand',{command:'dispose'});h.notify('host/windowStateChanged',{focused:false});assert.deepEqual((await state(h)).events,[]);assert.equal((await state(h)).focused,false);
});
test('extension deactivation removes focus listeners before reactivation',async t=>{
 const h=await setup(t,true);await h.request('host/deactivate',{id:'test.focus'});await h.request('host/activate',{id:'test.focus'});h.notify('host/windowStateChanged',{focused:false});assert.equal((await state(h)).events.length,1);
});
