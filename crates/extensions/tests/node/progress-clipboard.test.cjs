'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const{fixture}=require('./rpc-fixture.cjs');
test('progress reports, supports cancellation through its owned status command and cleans up',async t=>{
 const host=await fixture(t,{'test.progress':{code:`const v=require('vscode');let resolve;exports.activate=()=>{v.commands.registerCommand('progress',()=>v.window.withProgress({title:'Work',cancellable:true},(progress,token)=>{progress.report({message:'Indexing',increment:25});return new Promise(r=>token.onCancellationRequested(()=>r('cancelled')))}));v.commands.registerCommand('scm',()=>v.window.withScmProgress(()=>Promise.resolve(42)));}`}});
 await host.request('host/activate',{id:'test.progress'});
 const pending=host.request('host/executeCommand',{command:'progress'});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('No progress command')),1000);const off=host.onNotification(m=>{if(m.method==='statusBar/set'&&m.params.text.includes('Indexing')&&m.params.command?.command.startsWith('openmind.progress.cancel.')){clearTimeout(timeout);off();resolve()}})});
 const status=host.messages.find(m=>m.method==='statusBar/set'&&m.params.text.includes('Indexing')&&m.params.command?.command.startsWith('openmind.progress.cancel.'));
 assert.match(status.params.text,/Indexing.*25%/);
 await host.request('host/executeCommand',{command:status.params.command.command});assert.equal(await pending,'cancelled');
 assert.equal(await host.request('host/executeCommand',{command:'scm'}),42);
 assert.ok(host.messages.some(m=>m.method==='commands/unregistered'&&m.params.command===status.params.command.command));
});
test('clipboard requests go through the frontend bridge and local external URIs retain query/fragment',async t=>{
 let clipboard='';const host=await fixture(t,{'test.clipboard':{code:`const v=require('vscode');exports.activate=()=>v.commands.registerCommand('clipboard',async()=>{await v.env.clipboard.writeText('hello');return [await v.env.clipboard.readText(),(await v.env.asExternalUri(v.Uri.parse('http://localhost:3000/a?q=1#x'))).toString()]})`}},{handleRequest(method,p){if(method==='clipboard/writeText')clipboard=p.text;if(method==='clipboard/readText')return clipboard;}});
 await host.request('host/activate',{id:'test.clipboard'});assert.deepEqual(await host.request('host/executeCommand',{command:'clipboard'}),['hello','http://localhost:3000/a?q=1#x']);
});
