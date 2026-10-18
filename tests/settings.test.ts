import test from 'node:test';import assert from 'node:assert/strict';
import { vmLoader, deferred, until } from './main-fixture';
test('settings migrate old API endpoints and scale safely; address changes cannot reuse an implicit old key', async () => {
  const {SettingsStore, publicSettings}=vmLoader({electron:{safeStorage:{isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s)}},'node:fs/promises':{
    readFile:async()=>JSON.stringify({deepseekUrl:'https://other.test/v1'}),mkdir:async()=>{},writeFile:async()=>{},rename:async()=>{}
  }})('src/settings.ts');
  const store=new SettingsStore('unused'); await store.load(); assert.equal(store.value.apiProvider,'custom'); assert.equal(store.value.petScale,1);
  await store.save({petScale:1.5,deepseekKey:'fictional-key'}); assert.equal(publicSettings(store.value).deepseekKey,'');
  await assert.rejects(store.save({deepseekUrl:'https://new.test/v1'}),/地址已改变/);
  for (const value of [0.4,2.1,NaN,Infinity]) await assert.rejects(store.save({petScale:value}),/桌宠大小/);
  await assert.rejects(store.save({apiProvider:'unknown'}),/供应商/);
  await store.save({deepseekUrl:'https://new.test/v1',deepseekKey:'fictional-new-key'}); assert.equal(store.value.deepseekUrl,'https://new.test/v1');
});
test('C2: concurrent settings patches serialize and merge from the last committed version', async () => {
  const hold=deferred();let writes=0,concurrent=0,max=0;const persisted:any[]=[];
  const load=vmLoader({electron:{safeStorage:{}},'node:fs/promises':{mkdir:async()=>{},writeFile:async(_file:string,text:string)=>{max=Math.max(max,++concurrent);writes++;if(writes===1)await hold.promise;persisted.push(JSON.parse(text));concurrent--;},rename:async()=>{}}});
  const {SettingsStore}=load('src/settings.ts');const store=new SettingsStore('unused');
  const first=store.save({userName:'新称呼'});const second=store.save({voiceStyle:'新语气'});
  await until(()=>writes===1);hold.resolve(undefined);await Promise.all([first,second]);
  assert.equal(max,1);assert.equal(store.value.userName,'新称呼');assert.equal(store.value.voiceStyle,'新语气');
  assert.equal(persisted[1].userName,'新称呼');assert.equal(persisted[1].voiceStyle,'新语气');
});
test('C2: failed settings write does not commit in memory or poison later saves', async () => {
  let fail=true;
  const {SettingsStore}=vmLoader({electron:{safeStorage:{}},'node:fs/promises':{mkdir:async()=>{},writeFile:async()=>{if(fail)throw new Error('EACCES');},rename:async()=>{}}})('src/settings.ts');
  const store=new SettingsStore('unused');await assert.rejects(store.save({userName:'失败值'}),/EACCES/);assert.equal(store.value.userName,'你');
  fail=false;await store.save({voiceStyle:'成功'});assert.equal(store.value.userName,'你');assert.equal(store.value.voiceStyle,'成功');
});
