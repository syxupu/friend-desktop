import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import { startModelProxy } from '../src/model-proxy';import type { Settings } from '../src/types';
import { deferred, until } from './main-fixture';
test('C1/C3: proxy cancellation closes the upstream stream and does not poison the next request',async()=>{
  const closed=deferred<void>();let requests=0;
  const upstream=http.createServer((req,res)=>{
    req.resume();requests++;
    if(requests===1){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"partial":true}\n\n');res.on('close',()=>closed.resolve());}
    else{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');}
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(upstream.address() as any).port}/v1`;
  const proxy=await startModelProxy(()=>({deepseekKey:'mock-key',deepseekUrl:url,deepseekModel:'mock'} as Settings));
  const send=()=>fetch(proxy.url+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${proxy.token}`,'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'test'}],stream:true}),signal:AbortSignal.timeout(2000)});
  try{
    const response=await send();const reader=response.body!.getReader();assert.ok((await reader.read()).value?.length);
    proxy.abortAll();await Promise.race([closed.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('upstream was not aborted')),1000)).then(value=>value)]);
    await reader.cancel();const next=await send();assert.equal((await next.json()).ok,true);assert.equal(requests,2);
  }finally{proxy.close();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});
