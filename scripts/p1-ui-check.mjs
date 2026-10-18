import { chromium } from 'playwright';import { pathToFileURL } from 'node:url';import path from 'node:path';import fs from 'node:fs';import assert from 'node:assert/strict';
const out=path.resolve('docs/p1-fixes');fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const cases=[];
try{
 for(const [width,height] of [[480,730],[390,640]]){
  const page=await browser.newPage({viewport:{width,height}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   const state={character:'测试角色',connection:'酒馆服务已停止，可重启对话服务',bookEntries:8,tavernReady:false,busy:false,configuring:false,speaking:false,
    study:{mode:'paused',topic:'高等数学',elapsedMs:180000,taskElapsedMs:180000,segment:2,rounds:3,chatReminderSent:false},
    settings:{userName:'你',ttsEnabled:true},foreground:{status:'inactive',current:null,lastExternal:null},
    messages:[{id:'one',role:'assistant',text:'已显示的部分回复。',cancelled:true}],
    persistence:{status:'error',dirty:true,error:'本机保存未完成，正在保留内存中的进度并重试。'},exitWarning:'退出前未能保存，已取消退出。仍然退出会丢失未保存的进度。'};
   window.friend={getState:async()=>state,onState:()=>()=>{},onAudio:()=>()=>{},action:async()=>{},control:async()=>{},send:async()=>{},saveSettings:async()=>{}};
  });
  await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);await page.waitForTimeout(100);
  await page.screenshot({path:path.join(out,`recovery-ui-${width}x${height}.png`)});
  const layout=await page.evaluate(()=>Object.fromEntries(['save-warning','retry-save','force-quit','restart-tavern','message','send','rounds','messages'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return[id,{top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height}]})));
  const contained=Object.values(layout).every(r=>r.top>=0&&r.bottom<=height&&r.left>=0&&r.right<=width);
  cases.push({width,height,contained,layout,pageErrors:errors});await page.close();
 }
}finally{await browser.close();}
const result={checkedAt:new Date().toISOString(),scope:'Actual built renderer with mocked IPC recovery state; no app data or providers',passed:cases.every(c=>c.contained&&!c.pageErrors.length),cases};
fs.writeFileSync(path.join(out,'ui-check.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));assert.equal(result.passed,true);
