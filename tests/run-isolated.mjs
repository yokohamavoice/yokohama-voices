// Run only after the intended site version has been built into dist/.
// Usage: node tests/run-isolated.mjs /absolute/site/path
// Optional: API_TEST_PORT=5184. Existing servers are never stopped or reused.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
const root=path.resolve(process.argv[2]||process.cwd());
const port=Number(process.env.API_TEST_PORT||5184);
if(!Number.isInteger(port)||port<1024||port>65535||port===5173)throw Error('Choose an unused test port other than 5173.');
const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await new Promise(resolve=>probe.close(resolve));
const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'yokohama-isolated-api-'));
const persist=path.join(dir,'state');
const wrangler=path.join(root,'node_modules/wrangler/bin/wrangler.js');
const sourceConfig=path.join(root,'dist/server/wrangler.json');
if(!fs.existsSync(sourceConfig))throw Error('Build the intended site version first; dist/server/wrangler.json is missing.');
const cfg=JSON.parse(await fsp.readFile(sourceConfig,'utf8'));
if(cfg.triggers?.crons?.length!==1||cfg.triggers.crons[0]!=='0 18 * * *')throw Error('Build the daily-analysis Worker first; the expected 03:00 JST schedule is missing.');
cfg.name='yokohama-isolated-api-test';
cfg.main=path.resolve(path.dirname(sourceConfig),cfg.main);
if(cfg.assets?.directory)cfg.assets.directory=path.resolve(path.dirname(sourceConfig),cfg.assets.directory);
cfg.d1_databases=[{binding:'DB',database_name:'yokohama-isolated-test',database_id:randomUUID()}];
cfg.r2_buckets=[{binding:'BUCKET',bucket_name:'yokohama-isolated-test'}];
cfg.vars={MODERATION_REPOSITORY:'project-test/yokohama-voices-moderation'};
const config=path.join(dir,'wrangler.json');await fsp.writeFile(config,JSON.stringify(cfg,null,2));
// Only this throwaway secret is loaded; no existing .dev.vars is read or copied.
await fsp.writeFile(path.join(dir,'.dev.vars'),`MODERATION_TOKEN=${randomBytes(32).toString('hex')}\n`,{mode:0o600});
const env={...process.env,CLOUDFLARE_CF_FETCH_ENABLED:'false',WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_PATH:path.join(dir,'logs'),WRANGLER_REGISTRY_PATH:path.join(dir,'dev-registry'),MINIFLARE_REGISTRY_PATH:path.join(dir,'miniflare-registry')};
function cli(args,{json=false}={}){const r=spawnSync(process.execPath,[wrangler,...args],{cwd:dir,env,encoding:'utf8',maxBuffer:20*1024*1024});if(r.error)throw r.error;if(r.status!==0)throw Error(`Local Wrangler failed (${args.slice(0,3).join(' ')}): ${r.stderr||r.stdout}`);return json?JSON.parse(r.stdout.trim()):r.stdout;}
const d1args=['d1','execute','DB','--local','--config',config,'--persist-to',persist];
const migrations=(await fsp.readdir(path.join(root,'drizzle'))).filter(x=>x.endsWith('.sql')).sort();
for(const file of migrations)cli([...d1args,'--file',path.join(root,'drizzle',file)]);
// A new, empty fixture DB can mark counters ready without a historical backfill.
// Existing data is never used by this runner; the SQL has an extra empty-vote guard.
const schema=cli([...d1args,'--command',"SELECT name FROM sqlite_master WHERE type='table' AND name='community_state'",'--json'],{json:true});
if(schema.some(x=>x.results?.some(r=>r.name==='community_state'))){
 cli([...d1args,'--command','UPDATE community_state SET votes=0,sessions=0,ready=1 WHERE id=1 AND NOT EXISTS(SELECT 1 FROM votes)']);
 const check=cli([...d1args,'--command','SELECT ready FROM community_state WHERE id=1','--json'],{json:true});
 if(!check.some(x=>x.results?.some(r=>r.ready===1)))throw Error('Fresh test DB counters are not ready; inspect the migration initializer.');
}
let test=await fsp.readFile(path.join(root,'tests/api.test.mjs'),'utf8');
if(!/const base\s*=/.test(test))throw Error('Review test harness: base declaration changed.');
test=test.replace(/const base\s*=\s*['"][^'"]+['"];?/,`const base='http://127.0.0.1:${port}';`);
const noticeSource=await fsp.readFile(path.join(root,'lib/public-data.ts'),'utf8');
const notice=noticeSource.match(/NOTICE_VERSION\s*=\s*['"]([^'"]+)['"]/);
if(notice)test=test.replace(/noticeVersion:\s*['"][^'"]+['"]/,`noticeVersion:${JSON.stringify(notice[1])}`);
await fsp.writeFile(path.join(dir,'api.test.mjs'),test);
await fsp.copyFile(path.join(root,'tests/daily-analysis.test.mjs'),path.join(dir,'daily-analysis.test.mjs'));
const log=fs.openSync(path.join(dir,'worker.log'),'a');
let worker;
try{
 worker=spawn(process.execPath,[path.join(root,'tests/isolated-worker.mjs'),config,persist,String(port)],{cwd:dir,env,stdio:['ignore',log,log]});
 worker.once('error',e=>{console.error('Test worker start failed:',e.message);});
 let ready=false;
 for(let i=0;i<120;i++){
  if(worker.exitCode!==null)throw Error(`Test worker exited; inspect ${path.join(dir,'worker.log')}`);
  try{const r=await fetch(`http://127.0.0.1:${port}/api/community`,{signal:AbortSignal.timeout(2000)});if(r.ok){ready=true;break;}}catch{}
  await new Promise(r=>setTimeout(r,250));
 }
 if(!ready)throw Error(`Test worker did not become ready; inspect ${path.join(dir,'worker.log')}`);
 // Miniflare's handler route accepts an explicit millisecond timestamp, allowing
 // tests to advance the daily refresh without any production HTTP endpoint.
 const testEnv={...env,API_TEST_BASE:`http://127.0.0.1:${port}`,API_TEST_SCHEDULE_URL:`http://127.0.0.1:${port}/cdn-cgi/handler/scheduled`,API_TEST_ROOT:root,API_TEST_CONFIG:config,API_TEST_PERSIST:persist,API_TEST_NOTICE:notice?.[1]||''};
 for(const file of ['api.test.mjs','daily-analysis.test.mjs']){
  const result=spawnSync(process.execPath,[path.join(dir,file)],{cwd:dir,env:testEnv,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(`${file} failed (${result.status}). Fixture retained at ${dir}`);
 }
 console.log(`PASS: isolated D1/R2 integration test. Fixture and logs: ${dir}`);
}finally{
 if(worker&&worker.exitCode===null){worker.kill('SIGTERM');await Promise.race([once(worker,'exit'),new Promise(r=>setTimeout(r,4000))]);if(worker.exitCode===null)worker.kill('SIGKILL');}
 fs.closeSync(log);
 console.log(`Only the test worker on port ${port} was stopped. Existing dev server 5173 was not used.`);
}
