import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
const base=process.env.API_TEST_BASE||'http://127.0.0.1:5184';
assert.ok(['127.0.0.1','localhost'].includes(new URL(base).hostname),'Tests are local-only');
const secret=(await fs.readFile('.dev.vars','utf8')).trim().split('=',2)[1];
const token=()=>randomBytes(32).toString('hex');
async function call(path,body,t,admin=false){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(t?{'x-session-token':t}:{}),...(admin?{Authorization:`Bearer ${secret}`}:{})},...(body?{body:JSON.stringify(body)}:{})});let data;const raw=await r.text();try{data=JSON.parse(raw);}catch{data={raw};}return {status:r.status,data,raw,headers:r.headers};}
async function ok(path,body,t,admin=false){const r=await call(path,body,t,admin);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
const request=(b,t)=>ok('/api/session',b,t);
const start=async()=>{const t=token();await request({action:'start',noticeVersion:'research-notice-2026-09-18-contact-v4'},t);return t;};
const queue=()=>ok('/api/moderation',null,null,true);
const decision=(op,action,extra={})=>({id:randomUUID(),action,opinionId:op.id,expectedRevision:op.revision,reviewedUnrelated:Number(op.unrelated||0),reviewedReports:Number(op.reports||0),actor:'すすすす',reason:'ローカル検証: ` $(echo unsafe) <script> は文字として保存',runUrl:'https://github.com/project-test/yokohama-voices-moderation/actions/runs/1',...extra});
const admin=b=>ok('/api/moderation',b,null,true);
assert.equal((await call('/api/moderation')).status,401);
assert.equal((await call('/api/moderation?view=raw&table=sessions')).status,401);
let t=await start();let d=await ok('/api/community',null,t);assert.equal(d.session.phase,'active');assert.equal(Object.keys(d.session.votes).length,0);
const allocated=await Promise.all(Array.from({length:5},()=>request({action:'next'},t)));let i=allocated[0].impression;assert.ok(i);assert.ok(allocated.every(x=>x.impression.id===i.id));assert.ok(i.probability>0);
const display={action:'event',id:randomUUID(),type:'shown',impressionId:i.id,clientAt:Date.now(),clientSequence:1};await request(display,t);await request(display,t);
assert.equal((await call('/api/session',{action:'vote',opinionId:i.opinion.id,value:-1},t)).status,400);
let answer={action:'vote',opinionId:i.opinion.id,impressionId:i.id,value:-1};await request(answer,t);await request(answer,t);assert.equal((await call('/api/session',{...answer,value:1},t)).status,409);
let next=(await request({action:'next'},t)).impression;assert.notEqual(next.id,i.id);assert.equal(next.sequence,i.sequence+1);
await request({action:'vote',opinionId:next.opinion.id,impressionId:next.id,value:2},t);
const a=await ok('/api/community?analysis=1',null,t);assert.ok(a.snapshotId);const cached=await Promise.all(Array.from({length:4},()=>ok('/api/community?analysis=1',null,t)));assert.ok(cached.every(x=>x.snapshotId===a.snapshotId));assert.ok(!JSON.stringify(a).includes('sessionIds'));assert.ok(!JSON.stringify(a).includes('object_key'));await request({action:'event',id:randomUUID(),type:'results_view',snapshotId:a.snapshotId,impressionId:next.id,clientAt:Date.now(),clientSequence:2},t);
await request({action:'finish'},t);const postId=randomUUID();await request({action:'post',id:postId,tagId:'transport',text:'LOCAL ONLY: this proposal must remain private until approved.'},t);
d=await ok('/api/community',null,t);assert.ok(!d.opinions.some(o=>o.id===postId));assert.ok(d.session.posts.includes(postId));
let q=await queue(),pending=q.queue.find(o=>o.id===postId);assert.equal(pending.status,'pending');const approval=decision(pending,'approve');
for(const patch of [{actor:'unconfigured-name'},{runUrl:'https://github.com/other-project/review/actions/runs/1'},{runUrl:'https://github.com/project-test/yokohama-voices-moderation/actions/runs/1?redirect=1'}])assert.equal((await call('/api/moderation',{...approval,...patch},null,true)).status,400);
await admin(approval);await admin(approval);assert.equal((await call('/api/moderation',{...approval,id:randomUUID()},null,true)).status,409);
d=await ok('/api/community');assert.ok(d.opinions.some(o=>o.id===postId));assert.ok(!JSON.stringify(d).includes('createdAt'));
await request({action:'end'},t);
// A card hidden after issuance cannot receive a new vote and is retired.
let t2=await start(),hiddenCard=(await request({action:'next'},t2)).impression;let op=(await ok('/api/community')).opinions.find(o=>o.id===hiddenCard.opinion.id);await admin(decision(op,'hide'));
assert.equal((await call('/api/session',{action:'vote',opinionId:op.id,impressionId:hiddenCard.id,value:-1},t2)).status,409);
assert.ok(!(await ok('/api/community?analysis=1')).opinions.some(o=>o.id===op.id));assert.notEqual((await request({action:'next'},t2)).impression.id,hiddenCard.id);
q=await queue();await admin(decision(q.hidden.find(o=>o.id===op.id),'restore'));
// Three flags produce a queue item but do not hide it.
const target=(await request({action:'next'},t2)).impression.opinion.id;
for(const participant of [t2,await start(),await start()]){for(let n=0;n<100;n++){const card=(await request({action:'next'},participant)).impression;assert.ok(card);await request({action:'vote',opinionId:card.opinion.id,impressionId:card.id,value:card.opinion.id===target?2:0},participant);if(card.opinion.id===target)break;if(n===99)assert.fail('Target not reached');}}
q=await queue();const flagged=q.queue.find(o=>o.id===target);assert.ok(flagged);assert.equal(flagged.status,'approved');const keep=decision(flagged,'keep');
// A report arriving after the reviewed snapshot stays in the queue.
const reporter=await start();await request({action:'report',opinionId:target,category:'personal_information'},reporter);await request({action:'report',opinionId:target,category:'personal_information'},reporter);await admin(keep);q=await queue();assert.ok(q.queue.some(o=>o.id===target));await admin(decision(q.queue.find(o=>o.id===target),'keep'));assert.ok(!(await queue()).queue.some(o=>o.id===target));
// A frozen draft cannot publish after a moderation change.
const prep=()=>decision({id:'unused',revision:0},'prepare_release',{id:randomUUID(),reason:'ローカル検証用の固定データ'});
async function prepare(){let r=(await admin(prep())).release;while(r.status==='preparing')r=(await admin(decision({id:'unused',revision:0},'continue_release',{releaseId:r.id,expectedRevision:r.build_revision}))).release;assert.equal(r.status,'draft');return r;}
async function table(root,name,privateView=true){const rows=[];let index=root.tables[name].index;while(index){const prefix=privateView?`/api/moderation?view=draft&id=${root.release.id}`:`/api/export?release=${root.release.id}`;const idx=await call(prefix+'&part='+index.part,null,null,privateView);assert.equal(createHash('sha256').update(idx.raw).digest('hex'),index.sha256);for(const page of idx.data.pages){const r=await call(prefix+'&part='+page.part,null,null,privateView);assert.equal(r.status,200);assert.equal(createHash('sha256').update(r.raw).digest('hex'),page.sha256);rows.push(...r.raw.trim().split('\n').filter(Boolean).map(JSON.parse));}index=idx.data.next;}assert.equal(rows.length,root.tables[name].rows);return rows;}
let draft=await prepare();let current=(await ok('/api/community')).opinions.find(o=>o.id===postId);await admin(decision(current,'hide'));
const publish=r=>decision({id:'unused',revision:0},'publish_release',{releaseId:r.id,sha256:r.sha256});
assert.equal((await call('/api/moderation',publish(draft),null,true)).status,409);
// Publish freezes data; later responses cannot leak into that release.
draft=await prepare();const privateDraft=await call(`/api/moderation?view=draft&id=${draft.id}`,null,null,true);assert.equal(createHash('sha256').update(privateDraft.raw).digest('hex'),draft.sha256);assert.ok(!(await table(privateDraft.data,'opinions')).some(o=>o.id===postId));
let more=await start(),card=(await request({action:'next'},more)).impression;await request({action:'vote',opinionId:card.opinion.id,impressionId:card.id,value:1},more);
assert.equal((await call('/api/moderation',{...publish(draft),sha256:'bad'},null,true)).status,409);await admin(publish(draft));
const exported=await call('/api/export');assert.equal(exported.status,200);assert.equal(exported.raw,privateDraft.raw);assert.equal(exported.data.schema_version,3);assert.equal(exported.headers.get('x-content-sha256'),draft.sha256);for(const forbidden of [secret,t,'token_hash','author_session','client_at','text_snapshot'])assert.ok(!exported.raw.includes(forbidden));
for(const name of ['opinions','responses','presentations']){const rows=await table(exported.data,name,false);for(const forbidden of [secret,t,'token_hash','author_session','client_at','text_snapshot'])assert.ok(!JSON.stringify(rows).includes(forbidden));}
const events=(await ok('/api/moderation?view=raw&table=events',null,null,true)).rows;assert.equal(events.filter(e=>e.id===display.id).length,1);assert.equal(events.find(e=>e.id===display.id).client_at,display.clientAt);assert.ok(events.some(e=>e.type==='results_view'));
const impressions=(await ok('/api/moderation?view=raw&table=impressions',null,null,true)).rows;const own=impressions.find(x=>x.id===i.id);assert.ok(own.displayed_at);assert.ok(own.answered_at);assert.ok(JSON.parse(own.candidates).probabilities.some(p=>p.id===i.opinion.id&&p.probability===i.probability));
console.log('PASS: local durable allocation/events, retry/concurrency, all four responses, private moderation, report watermarks, revision guards, frozen reviewed release, protected originals and public field exclusions.');
