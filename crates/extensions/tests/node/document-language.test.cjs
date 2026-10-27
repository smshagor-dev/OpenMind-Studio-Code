'use strict';
const { normalize } = require('node:path');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./rpc-fixture.cjs');
const initial={path:normalize('/workspace/a.txt'),languageId:'plaintext',text:'unsaved',version:7,isDirty:true};
const code=`const v=require('vscode');let old;const events=[];
exports.activate=()=>{v.workspace.onDidCloseTextDocument(d=>events.push(['close',d.languageId,d.isClosed,d.getText()]));v.workspace.onDidOpenTextDocument(d=>events.push(['open',d.languageId,d.isClosed,d.getText()]));
v.commands.registerCommand('change',async language=>{old=old||v.workspace.textDocuments[0];const d=await v.languages.setTextDocumentLanguage(v.workspace.textDocuments[0],language);return {language:d.languageId,text:d.getText(),version:d.version,dirty:d.isDirty,oldClosed:old.isClosed,same:old===d,events};});
v.commands.registerCommand('stale',()=>v.languages.setTextDocumentLanguage(old,'plaintext'));
v.commands.registerCommand('invalid',()=>v.languages.setTextDocumentLanguage({},'plaintext'));};`;
async function setup(t, virtual=false){let host;host=await fixture(t,{'test.language':{permissions:['commands','languages','workspaceRead'],code}},{handleRequest:async(method,p)=>{
 if(method==='workspace/getLanguages')return ['plaintext','javascript'];
 if(method==='workspace/setDocumentLanguage'){
  if(!['plaintext','javascript'].includes(p.languageId))throw Error('Unknown document language.');
  host.notify('host/documentLanguageChanged',{...initial,languageId:p.languageId});
  return {...initial,languageId:p.languageId};
 }
}});host.notify('host/documentOpened',{...initial,...(virtual?{path:'sample:///a',virtual:true}:{} )});await host.request('host/activate',{id:'test.language'});return host;}
const command=(h,name,...args)=>h.request('host/executeCommand',{command:name,args});
test('language changes retire old document identity and deliver close before open with dirty content preserved',async t=>{
 const h=await setup(t);const value=await command(h,'change','javascript');
 assert.deepEqual(value,{language:'javascript',text:'unsaved',version:7,dirty:true,oldClosed:true,same:false,events:[['close','plaintext',true,'unsaved'],['open','javascript',false,'unsaved']]});
 await assert.rejects(command(h,'stale'),/not open/);
 const again=await command(h,'change','javascript');assert.equal(again.events.length,2);
});
test('unknown language and malformed document reject without closing the document',async t=>{
 const h=await setup(t);await assert.rejects(command(h,'change','unknown'),/Unknown/);await assert.rejects(command(h,'invalid'),/not open/);
 const value=await command(h,'change','plaintext');assert.equal(value.same,true);assert.equal(value.oldClosed,false);assert.deepEqual(value.events,[]);
});
test('provider-only virtual documents change language without opening a filesystem path',async t=>{
 const h=await setup(t,true);const value=await command(h,'change','javascript');assert.equal(value.language,'javascript');assert.equal(value.oldClosed,true);assert.equal(value.text,'unsaved');assert.equal(h.messages.some(m=>m.method==='workspace/setDocumentLanguage'),false);
});
