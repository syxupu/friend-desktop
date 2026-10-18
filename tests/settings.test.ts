import test from 'node:test';import assert from 'node:assert/strict';
import { vmLoader, deferred, until } from './main-fixture';
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
