'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const{fixture}=require('./rpc-fixture.cjs');
test('continuous profiles retain the request token after handler return and stop or teardown cancels it',async t=>{
 const host=await fixture(t,{'test.watch':{code:`const v=require('vscode');let latest;exports.activate=()=>{const c=v.tests.createTestController('watch','Watch');const item=c.createTestItem('one','One');c.items.add(item);c.createRunProfile('Watch',v.TestRunProfileKind.Run,(request,token)=>{latest=request;const run=c.createTestRun(request);run.passed(item);run.end()},true,undefined,true);c.createRunProfile('Once',v.TestRunProfileKind.Run,()=>{});v.commands.registerCommand('tick',()=>{const run=c.createTestRun(latest);const cancelled=run.token.isCancellationRequested;run.passed(item);run.end();return cancelled})}`}});
 await host.request('host/activate',{id:'test.watch'});
 const call=(op,params={})=>host.request('host/workbench',{domain:'tests',op,...params});
 const c=(await call('snapshot')).controllers[0],profile=c.profiles[0];
 await assert.rejects(call('run',{controller:c.handle,profile:c.profiles[1].id,continuous:true}),/does not support/);
 await call('run',{controller:c.handle,profile:profile.id,continuous:true});
 assert.equal((await call('snapshot')).controllers[0].profiles[0].continuous,true);
 assert.equal(await host.request('host/executeCommand',{command:'tick'}),false);
 await call('stopContinuous',{controller:c.handle,profile:profile.id});assert.equal(await host.request('host/executeCommand',{command:'tick'}),true);
 assert.equal((await call('snapshot')).controllers[0].profiles[0].continuous,false);
 await call('run',{controller:c.handle,profile:profile.id,continuous:true});await host.request('host/deactivate',{id:'test.watch'});assert.deepEqual((await call('snapshot')).controllers,[]);
});
