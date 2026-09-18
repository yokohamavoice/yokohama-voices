// Run after applying the additive migration. Only explicit administrator access
// can advance this resumable backfill; writes remain paused until completion.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const {creator}=JSON.parse(await readFile(new URL('../data/project.json',import.meta.url),'utf8')); 
const base=process.argv[2]||'http://127.0.0.1:5173';
const url=new URL(base);if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('This maintenance command is local-only.');
const vars=await readFile('.dev.vars','utf8');
const token=vars.match(/^MODERATION_TOKEN=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g,'');if(!token)throw Error('Local administrator token is missing.');
let completed=false;
for(let page=0;page<100000;page++){
 const r=await fetch(new URL('/api/moderation',url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({action:'initialize_counts',id:randomUUID(),actor:creator,reason:'既存データの集計を初期化',runUrl:'local:maintenance'})});
 const result=await r.json();if(!r.ok)throw Error(result.error||`HTTP ${r.status}`);
 if(result.state.ready){completed=true;console.log(`Counters ready: ${result.state.sessions} sessions, ${result.state.votes} responses.`);break;}
 if(page%50===0)console.log(`Initializing ${result.state.backfill_phase}, cursor ${result.state.backfill_cursor}`);
}
if(!completed)throw Error("Initialization is not finished. Run this command again to resume.");
