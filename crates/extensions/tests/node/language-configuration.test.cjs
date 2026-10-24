'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {fixture}=require('./rpc-fixture.cjs');
const code=`const v=require('vscode');let registration;exports.activate=()=>{
v.commands.registerCommand('configure',()=>{registration=v.languages.setLanguageConfiguration('demo',{comments:{lineComment:'//',blockComment:['/*','*/']},brackets:[['{','}']],wordPattern:/[a-z-]+/giu,indentationRules:{increaseIndentPattern:/[{]/u,decreaseIndentPattern:/[}]/u,indentNextLinePattern:/next/i,unIndentedLinePattern:/skip/},onEnterRules:[{beforeText:/before/i,afterText:/after/g,previousLineText:/previous/u,action:{indentAction:v.IndentAction.Indent,appendText:'* ',removeText:1}}],autoClosingPairs:[{open:'{',close:'}',notIn:[v.SyntaxTokenType.String,v.SyntaxTokenType.Comment,v.SyntaxTokenType.RegEx]}]});});
v.commands.registerCommand('dispose',()=>registration.dispose());
v.commands.registerCommand('legacy',()=>{v.languages.setLanguageConfiguration('demo',{__characterPairSupport:{autoClosingPairs:[{open:'(',close:')',notIn:['comment']}]},__electricCharacterSupport:{brackets:[],docComment:{scope:'ignored',open:'/**',lineStart:'ignored',close:'*/'}}});return true;});
v.commands.registerCommand('invalid',()=>{for(const config of [null,{wordPattern:'text'},{brackets:[['(']]},{indentationRules:{}},{onEnterRules:[{beforeText:/x/,action:{indentAction:9}}]},{onEnterRules:[{beforeText:/x/,action:{indentAction:0,removeText:-1}}]},{autoClosingPairs:[{open:1,close:'x'}]},{unknown:true}]){let threw=false;try{v.languages.setLanguageConfiguration('demo',config)}catch{threw=true}if(!threw)throw Error('invalid accepted');}return true;});};`;
async function setup(t){const h=await fixture(t,{'test.config':{permissions:['commands','languages'],code}});await h.request('host/activate',{id:'test.config'});return h;}
const command=(h,name)=>h.request('host/executeCommand',{command:name});
test('language configuration preserves regex source/flags, pairs and enter actions over real stdio',async t=>{
 const h=await setup(t);await command(h,'configure');const p=h.messages.find(m=>m.method==='languages/configuration').params;
 assert.equal(p.extension,'test.config');assert.equal(p.language,'demo');assert.match(p.handle,/^test.config:configuration:/);
 assert.deepEqual(p.configuration.wordPattern,{source:'[a-z-]+',flags:'giu'});assert.deepEqual(p.configuration.brackets,[['{','}']]);assert.deepEqual(p.configuration.comments,{lineComment:'//',blockComment:['/*','*/']});
 assert.deepEqual(p.configuration.autoClosingPairs[0].notIn,['string','comment','regex']);
 assert.deepEqual(p.configuration.indentationRules.increaseIndentPattern,{source:'[{]',flags:'u'});assert.deepEqual(p.configuration.onEnterRules[0].action,{indentAction:1,appendText:'* ',removeText:1});assert.deepEqual(p.configuration.onEnterRules[0].previousLineText,{source:'previous',flags:'u'});
});
test('invalid configurations reject synchronously without sending registrations',async t=>{const h=await setup(t);assert.equal(await command(h,'invalid'),true);assert.equal(h.messages.some(m=>m.method==='languages/configuration'),false);});
test('explicit disposal is idempotent and extension shutdown unregisters remaining configurations',async t=>{
 const h=await setup(t);await command(h,'configure');const first=h.messages.find(m=>m.method==='languages/configuration').params.handle;await command(h,'dispose');await command(h,'dispose');assert.equal(h.messages.filter(m=>m.method==='languages/unregistered'&&m.params.handle===first).length,1);
 await command(h,'configure');await h.request('host/deactivate',{id:'test.config'});assert.equal(h.messages.filter(m=>m.method==='languages/unregistered').length,2);
});

test('deprecated pair and doc-comment forms normalize while obsolete fields are ignored',async t=>{
 const h=await setup(t);await command(h,'legacy');const config=h.messages.find(m=>m.method==='languages/configuration').params.configuration;
 assert.deepEqual(config.autoClosingPairs,[{open:'(',close:')',notIn:['comment']}]);assert.deepEqual(config.__electricCharacterSupport,{docComment:{open:'/**',close:'*/'}});
});
test('configuration registration requires the language permission',async t=>{
 const h=await fixture(t,{'test.config':{permissions:['commands'],code}});await h.request('host/activate',{id:'test.config'});await assert.rejects(command(h,'configure'),/languages/);assert.equal(h.messages.some(m=>m.method==='languages/configuration'),false);
});
