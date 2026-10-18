import test from 'node:test';import assert from 'node:assert/strict';
import { SnapshotWriter } from '../src/persistence';import { deferred, until } from './main-fixture';
test('S2: failed writes retry the newest snapshot and visibly recover', async () => {
  const writes:string[]=[];let fail=true;
  const writer=new SnapshotWriter('unused',()=>{}, {retryMs:10,write:async s=>{writes.push(s);if(fail)throw new Error('EACCES');}});
  try {
    const first=writer.save('old',500);await until(()=>writer.snapshot().status==='error');
    assert.equal(writer.snapshot().dirty,true);fail=false;
    const last=writer.save('new',500);assert.equal(await last,true);assert.equal(await first,true);
    assert.deepEqual(writes,['old','new']);assert.equal(writer.snapshot().status,'saved');assert.equal(writer.snapshot().dirty,false);
  }finally{writer.close();}
});
test('S2: a hung write times out callers without releasing file ownership or writing stale data over new', async () => {
  const hold=deferred<void>();const writes:string[]=[];let concurrent=0,max=0;
  const writer=new SnapshotWriter('unused',()=>{}, {write:async s=>{max=Math.max(max,++concurrent);writes.push(s);if(s==='A')await hold.promise;concurrent--;}});
  try {
    const a=writer.save('A',20),b=writer.save('B',20),c=writer.save('C',20);
    assert.deepEqual(await Promise.all([a,b,c]),[false,false,false]);assert.equal(writer.snapshot().status,'error');assert.deepEqual(writes,['A']);
    hold.resolve();await until(()=>writer.snapshot().status==='saved');assert.deepEqual(writes,['A','C']);assert.equal(max,1);
    assert.equal(writer.snapshot().dirty,false);
  }finally{hold.resolve();writer.close();}
});
test('S2: close cancels pending waiters and scheduled retries', async () => {
  let attempts=0;const writer=new SnapshotWriter('unused',()=>{}, {retryMs:30,write:async()=>{attempts++;throw new Error('failed');}});
  const wait=writer.save('snapshot',500);await until(()=>writer.snapshot().status==='error');writer.close();
  assert.equal(await wait,false);await new Promise(r=>setTimeout(r,45));assert.equal(attempts,1);
});
