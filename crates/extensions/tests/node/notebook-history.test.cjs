'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {fixture}=require('./rpc-fixture.cjs');
test('notebook text and structural edits undo/redo with monotonic versions and divergent history',async t=>{
 const host=await fixture(t,{'test.history':{permissions:['workspaceRead','workspaceWrite','commands'],code:`const v=require('vscode'); exports.activate=()=>{v.workspace.registerNotebookSerializer('history',{deserializeNotebook:()=>new v.NotebookData([]),serializeNotebook:data=>Buffer.from(JSON.stringify(data))});v.commands.registerCommand('new',async()=>{const d=await v.workspace.openNotebookDocument('history',new v.NotebookData([new v.NotebookCellData(v.NotebookCellKind.Code,'original','javascript')]));return d.uri.toString()})}`}});
 await host.request('host/activate',{id:'test.history'});
 const uri=await host.request('host/executeCommand',{command:'new'});
 const call=(op,params={})=>host.request('host/workbench',{domain:'notebooks',op,uri,...params});
 const doc=async()=>(await call('snapshot')).documents[0];
 let before=await doc();await call('edit',{index:0,value:'edited',version:before.version});
 let edited=await doc();assert.equal(edited.canUndo,true);await call('undo',{version:edited.version});
 let undone=await doc();assert.equal(undone.cells[0].value,'original');assert.ok(undone.version>edited.version);assert.equal(undone.canRedo,true);
 await call('redo',{version:undone.version});let redone=await doc();assert.equal(redone.cells[0].value,'edited');
 await assert.rejects(call('undo',{version:undone.version}),/changed/);
 await call('undo',{version:redone.version});undone=await doc();await call('edit',{index:0,value:'divergent',version:undone.version});assert.equal((await doc()).canRedo,false);
 const current=await doc();await call('insert',{index:1,cellIds:current.cells.map(c=>c.id),version:current.version,languageId:'javascript'});
 const inserted=await doc();assert.equal(inserted.cells.length,2);await call('undo',{version:inserted.version});assert.equal((await doc()).cells.length,1);
});
