'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const{fixture}=require('./rpc-fixture.cjs');
const code=`const v=require('vscode');let pick,input;const events=[];exports.activate=()=>{
 v.commands.registerCommand('show',()=>{pick=v.window.createQuickPick();const item={label:'Original',secret:42,buttons:[{tooltip:'Edit'}]};pick.items=[item];pick.buttons=[v.QuickInputButtons.Back];pick.onDidChangeValue(value=>{events.push(value);pick.items=[item,{label:value}]});pick.onDidChangeSelection(items=>events.push(items[0]===item?'identity':'wrong'));pick.onDidTriggerButton(button=>events.push(button===v.QuickInputButtons.Back?'back':'wrong'));pick.onDidTriggerItemButton(value=>events.push(value.item===item&&value.button===item.buttons[0]?'edit':'wrong'));pick.onDidAccept(()=>{events.push('accept');pick.hide()});pick.onDidHide(()=>events.push('hide'));pick.show()});
 v.commands.registerCommand('input',()=>{input=v.window.createInputBox();input.validationMessage='Invalid';input.onDidAccept(()=>events.push('inputAccepted'));input.show()});v.commands.registerCommand('valid',()=>{input.validationMessage=undefined});
 v.commands.registerCommand('events',()=>events);v.commands.registerCommand('dispose',()=>pick.dispose());
};`;
async function setup(t){const host=await fixture(t,{'test.quick':{code}});await host.request('host/activate',{id:'test.quick'});return host;}
const latest=host=>host.messages.filter(m=>m.method==='quickInput/set'&&m.params.visible).at(-1)?.params;
test('dynamic quick pick updates live items and returns original selection/button objects',async t=>{
 const host=await setup(t);await host.request('host/executeCommand',{command:'show'});let state=latest(host);const id=state.id,original=state.items[0];
 await host.request('host/quickInputEvent',{id,event:'value',value:'Updated'});state=latest(host);assert.equal(state.items[1].label,'Updated');
 await host.request('host/quickInputEvent',{id,event:'selection',items:[original.id]});
 await host.request('host/quickInputEvent',{id,event:'button',button:state.buttons[0].id});
 await host.request('host/quickInputEvent',{id,event:'itemButton',item:original.id,button:original.buttons[0].id});
 await host.request('host/quickInputEvent',{id,event:'accept'});
 assert.deepEqual(await host.request('host/executeCommand',{command:'events'}),['Updated','identity','back','edit','accept','hide']);
 await host.request('host/executeCommand',{command:'dispose'});
 await host.request('host/quickInputEvent',{id,event:'accept'});assert.equal((await host.request('host/executeCommand',{command:'events'})).length,6);
});
test('input validation blocks acceptance and extension teardown removes visible inputs',async t=>{
 const host=await setup(t);await host.request('host/executeCommand',{command:'input'});const id=latest(host).id;
 await host.request('host/quickInputEvent',{id,event:'accept'});assert.deepEqual(await host.request('host/executeCommand',{command:'events'}),[]);
 await host.request('host/executeCommand',{command:'valid'});await host.request('host/quickInputEvent',{id,event:'accept'});assert.deepEqual(await host.request('host/executeCommand',{command:'events'}),['inputAccepted']);
 await host.request('host/deactivate',{id:'test.quick'});assert.ok(host.messages.some(m=>m.method==='quickInput/set'&&m.params.id===id&&m.params.visible===false));
});
