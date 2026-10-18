import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const out=path.resolve('docs/p1-fixes');fs.mkdirSync(out,{recursive:true});
const commands=[['typecheck',['node_modules/typescript/bin/tsc','--noEmit']],['unit',['--import','tsx','--test','--test-reporter=tap',...fs.readdirSync('tests').filter(f=>f.endsWith('.test.ts')).map(f=>'tests/'+f)]]];
const results=[];
for(const [name,args] of commands){
 const run=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:8*1024*1024});
 fs.writeFileSync(path.join(out,name+'.log'),run.stdout+run.stderr);
 const count=key=>Number(run.stdout.match(new RegExp('# '+key+' (\\d+)'))?.[1]??0);
 results.push({name,command:[process.execPath,...args],exitCode:run.status,...(name==='unit'?{tests:count('tests'),passed:count('pass'),failed:count('fail')}:{}),log:name+'.log'});
 if(run.status!==0){console.error(run.stdout+run.stderr);process.exitCode=1;break;}
}
const report={checkedAt:new Date().toISOString(),appVersion:JSON.parse(fs.readFileSync('package.json','utf8')).version,passed:results.length===commands.length&&results.every(r=>r.exitCode===0),results};
fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
