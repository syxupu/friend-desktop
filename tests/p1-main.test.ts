import test from 'node:test';
import assert from 'node:assert/strict';
import { mainFixture, deferred, tick, until } from './main-fixture';

test('S1: delayed disk completion never opens a break conversation in a later segment', async () => {
  const f = mainFixture();
  try {
    await f.api.control('start','旧段');
    const disk = deferred<boolean>(); let hold = true;
    f.api.setPersist(() => { if (hold) { hold = false; return disk.promise; } return Promise.resolve(true); });
    const ending = f.api.control('end');
    assert.equal(f.calls.filter(c => c.method === 'generate').length,1);
    assert.equal(f.calls[0].data.study.mode,'break');
    await f.api.control('start','新段'); await until(() => !f.api.inspect().busy);
    disk.resolve(true); await ending; await tick();
    assert.equal(f.api.inspect().study.mode,'study');
    assert.equal(f.calls.filter(c=>c.method==='generate').length,1);
    assert.equal(f.api.inspect().study.rounds,0);
  } finally { await f.cleanup(); }
});
test('S1: end while generating claims exactly one opening; duplicate end cannot repeat it', async () => {
  const f = mainFixture();
  try {
    await f.api.control('start');const sending=f.api.generate('旧段问题');
    await f.api.control('end');await f.api.control('end');await sending;
    await until(()=>f.calls.filter(c=>c.data?.automatic).length===1);
    const openings=f.calls.filter(c=>c.data?.automatic);assert.equal(openings[0].data.study.mode,'break');
    f.reply();await until(()=>!f.api.inspect().busy);await f.api.control('end');
    assert.equal(f.calls.filter(c=>c.data?.automatic).length,1);
  } finally { await f.cleanup(); }
});
test('C1: stopping audio fences in-flight text TTS but permits audio for a new request', async () => {
  const f=mainFixture();
  try {
    await f.api.control('start');const first=f.api.generate('问题一');f.api.stopAudio();f.reply();await first;await tick();
    assert.equal(f.syntheses(),0);assert.ok(f.api.inspect().messages.some((m:any)=>m.text==='“测试回复。”'));
    const second=f.api.generate('问题二');f.reply();await second;await tick();assert.equal(f.syntheses(),1);
  } finally { await f.cleanup(); }
});
test('C1: explicit cancellation retains partial text, rejects late stream, counts no round and admits a new request', async () => {
  const f=mainFixture();
  try {
    await f.api.control('start');const sending=f.api.generate('问题');
    const pending=f.api.inspect().messages.at(-1);pending.text='已显示的部分';
    const cancellation=f.api.cancelGeneration();f.stream(pending.id,'迟到内容不得覆盖');await cancellation;await sending;
    assert.equal(f.api.inspect().busy,false);assert.equal(pending.cancelled,true);assert.equal(pending.text,'已显示的部分');
    assert.equal(f.api.inspect().study.rounds,0);assert.equal(f.syntheses(),0);
    const next=f.api.generate('新问题');f.reply();await next;assert.equal(f.api.inspect().study.rounds,1);
  } finally { await f.cleanup(); }
});
test('C1: finishing the task cancels the request and cannot revive voice or counters', async () => {
  const f=mainFixture();
  try {
    await f.api.control('start');const sending=f.api.generate('问题');await f.api.control('finish');await sending;
    assert.equal(f.api.inspect().study.mode,'idle');assert.equal(f.api.inspect().study.rounds,0);assert.equal(f.syntheses(),0);
    await f.api.control('finish');assert.equal(f.calls.length,1);
  } finally { await f.cleanup(); }
});
test('C2: settings admission is synchronous across disk awaits and keeps local notices', async () => {
  const f=mainFixture();
  try {
    const disk=deferred();const settings=f.api.inspect().settings;
    f.api.setStore({value:{...settings,deepseekKey:'mock',mimoKey:'mock'},save:()=>disk.promise});
    await f.api.control('start','保留通知');const saving=f.api.saveSettings({userName:'新称呼'});
    assert.equal(f.api.inspect().configuring,true);
    await assert.rejects(f.api.generate('不能交错'),/保存设置/);
    await assert.rejects(f.api.saveSettings({userName:'第二份'}),/尚未完成/);
    assert.equal(f.calls.length,0);
    disk.resolve(undefined);await saving;
    assert.equal(f.api.inspect().configuring,false);assert.equal(f.calls[0].method,'configure');
    assert.ok(f.api.inspect().messages.some((m:any)=>m.role==='notice'&&m.text.includes('保留通知')));
    const sending=f.api.generate('正常请求');await assert.rejects(f.api.saveSettings({}),/尚未完成/);f.reply();await sending;
  } finally { await f.cleanup(); }
});
test('S2: save failure cannot suppress a committed end or cause a second opening', async () => {
  const f=mainFixture();
  try {
    await f.api.control('start');f.api.setPersist(async()=>false);
    await f.api.control('end');assert.equal(f.api.inspect().study.mode,'break');
    assert.ok(f.api.inspect().messages.some((m:any)=>m.text.includes('进入休息')));
    f.reply();await until(()=>!f.api.inspect().busy);await f.api.control('end');
    assert.equal(f.calls.filter(c=>c.data?.automatic).length,1);
  } finally { await f.cleanup(); }
});
test('S2: unsuccessful shutdown returns to the app visibly; force quit requires actual dirty data', async () => {
  const f=mainFixture();
  try {
    f.api.setPersist(async()=>false);f.api.setDirty();await f.api.shutdown();
    assert.equal(f.app.quitCalls,0);assert.ok(f.api.inspect().messages.some((m:any)=>m.text.includes('已取消退出')));
    await f.handlers.get('friend:action')!(f.sender,'force-quit');assert.equal(f.app.quitCalls,1);
  } finally { await f.cleanup(); }
});
test('C2/S2: quit cannot silently abandon a pending settings commit', async () => {
  const f=mainFixture();
  const disk=deferred();
  try {
    f.api.setStore({value:{...f.api.inspect().settings,deepseekKey:'mock'},save:()=>disk.promise});
    const saving=f.api.saveSettings({userName:'尚未写完'});await f.api.shutdown();
    assert.equal(f.app.quitCalls,0);assert.equal(f.api.inspect().configuring,true);
    assert.match(f.api.inspect().exitWarning,/设置操作尚未完成/);
    disk.resolve(undefined);await saving;assert.equal(f.api.inspect().configuring,false);
    assert.equal(f.api.inspect().exitWarning,undefined);
  } finally {disk.resolve(undefined);await f.cleanup();}
});
