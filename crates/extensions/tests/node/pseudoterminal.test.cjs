'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const{fixture}=require('./rpc-fixture.cjs');
test('extension pseudoterminal routes text, input, dimensions and owner-checked close exactly once',async t=>{
 const host=await fixture(t,{'test.pty':{permissions:['terminal','commands'],code:`const v=require('vscode');let terminal;const log=[];exports.activate=()=>{v.commands.registerCommand('open',async()=>{const out=new v.EventEmitter();terminal=v.window.createTerminal({name:'Virtual',pty:{onDidWrite:out.event,open(size){log.push(size);out.fire('Ready\\r\\n')},handleInput(text){log.push(text);out.fire(text)},setDimensions(size){log.push(size)},close(){log.push('closed')}}});await terminal.processId;return terminal.name});v.commands.registerCommand('log',()=>log)}`}});
 await host.request('host/activate',{id:'test.pty'});assert.equal(await host.request('host/executeCommand',{command:'open'}),'Virtual');
 const created=host.messages.find(m=>m.method==='terminal/create').params;assert.equal(created.pseudo,true);assert.ok(host.messages.some(m=>m.method==='terminal/ptyWrite'&&m.params.data==='Ready\r\n'));
 host.notify('host/ptyEvent',{id:created.id,extension:'wrong.owner',event:'input',data:'bad'});
 host.notify('host/ptyEvent',{id:created.id,extension:'test.pty',event:'input',data:'typed'});
 host.notify('host/ptyEvent',{id:created.id,extension:'test.pty',event:'resize',columns:120,rows:40});
 host.notify('host/terminalClosed',{id:created.id});host.notify('host/ptyEvent',{id:created.id,extension:'test.pty',event:'close'});
 assert.deepEqual(await host.request('host/executeCommand',{command:'log'}),[{columns:80,rows:24},'typed',{columns:120,rows:40},'closed']);
});
test('CustomExecution returns a task execution even when its terminal finishes during open',async t=>{
 let host;const events=[];
 host=await fixture(t,{'test.custom':{permissions:['terminal','commands'],code:`const v=require('vscode');const events=[];exports.activate=()=>{v.tasks.onDidStartTask(()=>events.push('start'));v.tasks.onDidEndTask(()=>events.push('end'));v.tasks.onDidStartTaskProcess(()=>events.push('process'));v.commands.registerCommand('run',async()=>{const execution=new v.CustomExecution(async definition=>{if(definition.type!=='custom')throw Error('definition');const out=new v.EventEmitter(),close=new v.EventEmitter();return {onDidWrite:out.event,onDidClose:close.event,open(){out.fire('Task output');close.fire(0)},close(){}}});const task=new v.Task({type:'custom'},v.TaskScope.Workspace,'Custom','test',execution);const running=await v.tasks.executeTask(task);return {same:running.task===task,events}})}`}}, {handleRequest(method,p){events.push(method);if(method==='tasks/execute')return host.request('host/executeCustomTask',{handle:p.task.handle});return {pid:null};}});
 await host.request('host/activate',{id:'test.custom'});assert.deepEqual(await host.request('host/executeCommand',{command:'run'}),{same:true,events:['start','end']});assert.ok(events.includes('terminal/create'));
});
test('native task descriptors preserve literal process arguments and validate current workspace trust',async t=>{
 const host=await fixture(t,{'test.process':{permissions:['terminal'],code:`const v=require('vscode');exports.activate=()=>v.tasks.registerTaskProvider('literal',{provideTasks(){return [new v.Task({type:'literal'},v.TaskScope.Workspace,'Literal','test',new v.ProcessExecution('tool',['a b',"$env:SECRET; Remove-Item x",'quote"'],{env:{MODE:'test'}}))]}})`}});
 await host.request('host/activate',{id:'test.process'});
 const {tasks}=await host.request('host/provideTasks',{});assert.equal(tasks.length,1);
 assert.equal(tasks[0].program,'tool');assert.deepEqual(tasks[0].args,['a b','$env:SECRET; Remove-Item x','quote"']);
 assert.equal(await host.request('host/validateTask',{handle:tasks[0].handle}),true);
 host.notify('host/workspaceFoldersChanged',{folders:[{path:host.extensions[0].path,name:'Work'}]});
 await assert.rejects(host.request('host/validateTask',{handle:tasks[0].handle}),/Trust this workspace/);
 await assert.rejects(host.request('host/validateTask',{handle:'unknown'}),/Trust this workspace/);
});
test('task definitions activate providers implicitly while malformed neighboring manifests are isolated',async t=>{
 const host=await fixture(t,{
  'test.bad':{code:'exports.activate=()=>{}',files:{'package.json':'{broken'}},
  'test.implicit':{permissions:['terminal'],files:{'package.json':JSON.stringify({name:'implicit',contributes:{taskDefinitions:[{type:'implicit',required:[]}]}})},code:`const v=require('vscode');exports.activate=()=>v.tasks.registerTaskProvider('implicit',{provideTasks(){return [new v.Task({type:'implicit'},v.TaskScope.Workspace,'Implicit','test',new v.ProcessExecution('tool',[]))]}})`}
 });
 const {tasks}=await host.request('host/provideTasks',{});assert.equal(tasks.length,1);assert.equal(tasks[0].extension,'test.implicit');
});
