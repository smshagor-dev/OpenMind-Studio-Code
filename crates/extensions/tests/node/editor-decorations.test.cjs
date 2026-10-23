'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./rpc-fixture.cjs');

test('decoration types route ranges and safe hovers to their pane, clear and dispose exactly once',async t=>{
 const host=await fixture(t,{'test.decoration':{permissions:['commands'],code:`const v=require('vscode');let type,editor;exports.activate=()=>{
 v.commands.registerCommand('decorate',()=>{editor=v.window.activeTextEditor;type=v.window.createTextEditorDecorationType({backgroundColor:new v.ThemeColor('editor.background'),rangeBehavior:v.DecorationRangeBehavior.ClosedClosed,before:{contentText:'hint'},dark:{color:'white'}});const hover=new v.MarkdownString('hello');hover.isTrusted=true;hover.supportHtml=true;editor.setDecorations(type,[{range:new v.Range(0,0,0,4),hoverMessage:[hover,'plain'],renderOptions:{after:{contentText:' end'}}}]);return type.key});
 v.commands.registerCommand('clearDecoration',()=>editor.setDecorations(type,[]));
 v.commands.registerCommand('disposeDecoration',()=>{type.dispose();type.dispose();try{editor.setDecorations(type,[]);return false}catch{return true}});
 }`}});
 await host.request('host/activate',{id:'test.decoration'});
 host.notify('host/documentOpened',{path:'/tmp/decorations.txt',text:'hello',version:1,languageId:'plaintext'});
 host.notify('host/editorSnapshot',{editors:[{id:'pane',path:'/tmp/decorations.txt',selections:[],tabSize:4,insertSpaces:true}],activeId:'pane'});
 const key=await host.request('host/executeCommand',{command:'decorate'});
 const messages=()=>host.messages.filter(m=>m.method?.startsWith('editor/')&&m.method.includes('Decoration')).map(({method,params})=>({method,params}));
 assert.deepEqual(messages()[0],{method:'editor/createDecoration',params:{extension:'test.decoration',key,options:{backgroundColor:{id:'editor.background'},rangeBehavior:1,before:{contentText:'hint'},dark:{color:'white'}}}});
 assert.deepEqual(messages()[1],{method:'editor/setDecorations',params:{extension:'test.decoration',key,path:'/tmp/decorations.txt',editorId:'pane',decorations:[{range:{startLine:0,startColumn:0,endLine:0,endColumn:4},hoverMessage:[{value:'hello'},{value:'plain'}],renderOptions:{after:{contentText:' end'}}}]}});
 await host.request('host/executeCommand',{command:'clearDecoration'});
 assert.deepEqual(messages()[2].params.decorations,[]);
 assert.equal(await host.request('host/executeCommand',{command:'disposeDecoration'}),true);
 assert.equal(messages().filter(m=>m.method==='editor/disposeDecoration').length,1);
 await host.request('host/deactivate',{id:'test.decoration'});
 assert.equal(messages().filter(m=>m.method==='editor/disposeDecoration').length,1);
});

test('decoration teardown clears live types; unsupported fields and foreign types are refused',async t=>{
 const host=await fixture(t,{'test.decorationcleanup':{permissions:['commands'],code:`const v=require('vscode');exports.activate=()=>{
 v.commands.registerCommand('createType',()=>{const type=v.window.createTextEditorDecorationType({color:'red'});let foreign=false,unsupported=false,themed=false;try{v.window.activeTextEditor.setDecorations({key:type.key},[])}catch{foreign=true}try{v.window.createTextEditorDecorationType({gutterIconPath:v.Uri.file('/tmp/icon.svg')})}catch{unsupported=true}try{v.window.createTextEditorDecorationType({dark:{before:{contentText:'theme'}}})}catch{themed=true}return{foreign,unsupported,themed,key:type.key}});
 }`}});
 await host.request('host/activate',{id:'test.decorationcleanup'});
 host.notify('host/documentOpened',{path:'/tmp/decorations.txt',text:'hello',version:1,languageId:'plaintext'});
 host.notify('host/activeEditorChanged',{editor:{path:'/tmp/decorations.txt',selections:[]}});
 const result=await host.request('host/executeCommand',{command:'createType'});
 assert.equal(result.foreign,true);assert.equal(result.unsupported,true);assert.equal(result.themed,true);
 await host.request('host/deactivate',{id:'test.decorationcleanup'});
 assert.equal(host.messages.filter(m=>m.method==='editor/disposeDecoration'&&m.params.key===result.key).length,1);
});
