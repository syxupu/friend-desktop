import test from 'node:test';import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';import net from 'node:net';
import { vmLoader, deferred } from './main-fixture';

function runtimeFixture(options: { probeHang?: boolean; bridgeHang?: boolean; loadHang?: boolean; stopHang?: boolean } = {}) {
  const requests:any[]=[];let exits=0,probeCalls=0,probeActive=0;const pending=deferred();
  class Child extends EventEmitter { pid=123;exitCode:number|null=null;signalCode=null;kills=0;stderr={resume(){}};kill(){this.kills++;this.exitCode=0;queueMicrotask(()=>this.emit('exit',0));} }
  const child=new Child();
  class Window extends EventEmitter {
    destroyed=false;
    webContents=Object.assign(new EventEmitter(),{setWindowOpenHandler(){},executeJavaScript:async(code:string)=>{
      requests.push(code);
      if(code==='bridge-init'&&options.bridgeHang)return new Promise(()=>{});
      if(code.includes('friendBridge["generate"]'))return pending.promise;
      if(code==='window.friendBridge.stop()'){if(options.stopHang)return new Promise(()=>{});pending.resolve({text:'cancelled'});}
      return {};
    }});
    async loadURL(){if(options.loadHang)await new Promise(()=>{});}
    isDestroyed(){return this.destroyed;}
    destroy(){this.destroyed=true;this.emit('closed');}
    show(){} focus(){}
  }
  const load=vmLoader({electron:{BrowserWindow:Window,app:{isPackaged:false}},'node:net':net,
    'node:child_process':{spawn:()=>child},'node:fs/promises':{access:async()=>{},mkdir:async()=>{},writeFile:async()=>{},readFile:async()=> 'bridge-init'}},
    {fetch:async(_url:string,init:any)=>{
      probeCalls++;if(!options.probeHang)return {ok:true,body:{cancel:async()=>{}}};
      probeActive++;try{await new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});if(init.signal.aborted)reject(new Error('aborted'));});}
      finally{probeActive--;}
    }});
  const {TavernRuntime}=load('src/tavern.ts');
  const runtime=new TavernRuntime('unused','unused',()=>exits++,{startup:120,probe:20,bridge:45,generate:70,cancel:25});
  return {runtime,child,pending,requests,exits:()=>exits,probeCalls:()=>probeCalls,probeActive:()=>probeActive};
}
for(const [name,options] of [['hung CSRF fetch',{probeHang:true}],['missing APP_READY',{bridgeHang:true}],['hung page load',{loadHang:true}]] as const){
  test(`C3: startup bounds ${name} and disposes its runtime`,async()=>{
    const f=runtimeFixture(options);await assert.rejects(f.runtime.start(),/启动超时/);
    assert.equal(f.child.kills,1);assert.equal(f.exits(),1);assert.ok(f.probeCalls()>0);
    if(options.probeHang)assert.equal(f.probeActive(),0);
    if(f.runtime.window)assert.equal(f.runtime.window.destroyed,true);
  });
}
test('C3: generation deadline destroys the producer before another call can be admitted',async()=>{
  const f=runtimeFixture();await f.runtime.start();
  await assert.rejects(f.runtime.call('generate',{id:'one'}),/生成超时/);
  assert.equal(f.runtime.window.destroyed,true);assert.equal(f.child.kills,1);
  await assert.rejects(f.runtime.call('generate',{id:'two'}),/生成超时/);
  assert.equal(f.requests.filter((r:string)=>r.includes('friendBridge["generate"]')).length,1);
});
test('C3: a hung configure/saveChat RPC shares the same bounded failure path',async()=>{
  const f=runtimeFixture();await f.runtime.start();
  f.runtime.window.webContents.executeJavaScript=()=>new Promise(()=>{});
  await assert.rejects(f.runtime.call('configure',{}),/操作超时/);assert.equal(f.child.kills,1);assert.equal(f.exits(),1);
});
test('C1/C3: cooperative stop settles the old generation before the next call',async()=>{
  const f=runtimeFixture();await f.runtime.start();const running=f.runtime.call('generate',{id:'one'});
  await f.runtime.stopGeneration();await running;assert.equal(f.child.kills,0);
  const next=f.runtime.call('generate',{id:'two'});await next;
  assert.equal(f.requests.filter((r:string)=>r.includes('friendBridge["generate"]')).length,2);f.runtime.close();
});
test('C1/C3: unresponsive stop kills the producer and rejects the outstanding call',async()=>{
  const f=runtimeFixture({stopHang:true});await f.runtime.start();
  const running=assert.rejects(f.runtime.call('generate',{id:'one'}),/取消生成超时/);
  await f.runtime.stopGeneration();await running;
  assert.equal(f.runtime.window.destroyed,true);assert.equal(f.child.kills,1);assert.equal(f.exits(),1);
});
test('C3: child exit settles in-flight calls immediately and notifies once',async()=>{
  const f=runtimeFixture();await f.runtime.start();
  const running=assert.rejects(f.runtime.call('generate',{id:'one'}),/服务已退出/);
  f.child.emit('exit',2);await running;assert.equal(f.runtime.window.destroyed,true);assert.equal(f.exits(),1);
});
