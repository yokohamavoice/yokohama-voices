import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
// Invoke with cwd set to the Site checkout. All writes stay in a temporary directory.
const siteRoot=process.cwd();
const require=createRequire(import.meta.url);
const ts=require(path.join(siteRoot,'node_modules/typescript'));
const source=await fs.readFile(path.join(siteRoot,'lib/releases.ts'),'utf8');
let code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
code=code.replace(/^import .*?;\n/gm,'');
const raw=new DatabaseSync(':memory:');
raw.exec(`
 CREATE TABLE community_state(id INTEGER PRIMARY KEY,moderation_revision INTEGER NOT NULL);
 INSERT INTO community_state VALUES(1,0);
 CREATE TABLE opinions(id TEXT PRIMARY KEY,tag_id TEXT,text TEXT,kind TEXT,source_ids TEXT,created_at INTEGER,status TEXT,revision INTEGER);
 CREATE TABLE votes(session_id TEXT,opinion_id TEXT,value INTEGER,unrelated INTEGER,created_at INTEGER,impression_id TEXT,PRIMARY KEY(session_id,opinion_id));
 CREATE INDEX votes_impression ON votes(impression_id);
 CREATE TABLE impressions(id TEXT PRIMARY KEY,session_id TEXT,opinion_id TEXT,sequence INTEGER,probability REAL,routing_version TEXT);
 CREATE TABLE events(id TEXT PRIMARY KEY,impression_id TEXT,type TEXT);
 CREATE INDEX events_impression_type ON events(impression_id,type);
 CREATE TABLE releases(id TEXT PRIMARY KEY,schema_version INTEGER,status TEXT,phase TEXT,cursor INTEGER,build_revision INTEGER,watermarks TEXT,counts TEXT,moderation_revision INTEGER,sha256 TEXT,object_key TEXT,created_at INTEGER,published_at INTEGER,summary TEXT,opinion_revisions TEXT,actor TEXT,reason TEXT,prepare_run_url TEXT);
 CREATE TABLE release_opinions(release_id TEXT,opinion_id TEXT,revision INTEGER,payload TEXT,PRIMARY KEY(release_id,opinion_id));
 CREATE TABLE release_parts(release_id TEXT,part_id TEXT,kind TEXT,object_key TEXT,sha256 TEXT,row_count INTEGER,byte_length INTEGER,PRIMARY KEY(release_id,part_id));
`);
class Prepared {
 constructor(sql,args=[]){this.sql=sql;this.args=args;}
 bind(...args){return new Prepared(this.sql,args);}
 execute(){const statement=raw.prepare(this.sql);if(statement.columns().length)return {results:statement.all(...this.args),meta:{changes:0}};const r=statement.run(...this.args);return {results:[],meta:{changes:Number(r.changes)}};}
 async run(){return this.execute();}
 async all(){return this.execute();}
 async first(){return this.execute().results[0]||null;}
}
const db={prepare(sql){return new Prepared(sql);},async batch(statements){raw.exec('BEGIN');try{const result=statements.map(s=>s.execute());raw.exec('COMMIT');return result;}catch(e){raw.exec('ROLLBACK');throw e;}}};
const objects=new Map();
const BUCKET={async put(key,payload){objects.set(key,payload);return {};},async get(key){const text=objects.get(key);return text===undefined?null:{body:new Response(text).body,size:Buffer.byteLength(text),text:async()=>text};}};
const seed=JSON.parse(await fs.readFile(path.join(siteRoot,'data/seed.json'),'utf8'));
const digest=async value=>createHash('sha256').update(value).digest('hex');
class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
const context={env:{BUCKET},database:()=>db,seed,digest,HttpError,validId:id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id),ROUTING_VERSION:'test-routing-v1'};
globalThis.__releaseTest=context;
const prefix=`const {env,database,seed,digest,HttpError,validId,ROUTING_VERSION}=globalThis.__releaseTest;\n`;
const temporaryDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'yokohama-releases-test-'));
const modulePath=path.join(temporaryDirectory,'releases.mjs');
try {
await fs.writeFile(modulePath,prefix+code);
const api=await import(pathToFileURL(modulePath).href);
raw.prepare('INSERT INTO opinions VALUES(?,?,?,?,?,?,?,?)').run('seed-001',seed.tags[0].id,'公開するテスト用の意見です。','seed','[]',0,'approved',0);
raw.prepare('INSERT INTO opinions VALUES(?,?,?,?,?,?,?,?)').run('pending-001',seed.tags[0].id,'未承認のテスト用の意見です。','participant','[]',1,'pending',0);
const insertVote=raw.prepare('INSERT INTO votes VALUES(?,?,?,?,?,?)');
raw.exec('BEGIN');
for(let i=0;i<128001;i++)insertVote.run('s-'+i,'seed-001',i%3-1,0,1,i===0?'imp-1':null);
raw.exec('COMMIT');
const insertImpression=raw.prepare('INSERT INTO impressions VALUES(?,?,?,?,?,?)');
raw.exec('BEGIN');
for(let i=1;i<=128001;i++)insertImpression.run('imp-'+i,'s-'+(i-1),'seed-001',1,.5,'test-routing-v1');
raw.exec('COMMIT');
const insertEvent=raw.prepare('INSERT INTO events VALUES(?,?,?)');
insertEvent.run('e-1','imp-1','shown');
insertEvent.run('e-2','imp-2','retired');
const id='11111111-1111-1111-1111-111111111111';
let release=await api.prepareRelease(id,'すすすす','大規模公開のテスト','https://github.com/project-test/yokohama-voices-moderation/actions/runs/1');
assert.equal(release.status,'preparing');
assert.equal(JSON.parse(release.watermarks).votes,128001);
assert.equal(JSON.parse(release.watermarks).impressions,128001);
// Late commits have old request timestamps but must remain outside the snapshot.
insertVote.run('late','seed-001',1,0,0,'imp-3');
insertEvent.run('late-shown','imp-2','shown');
insertEvent.run('late-retired','imp-3','retired');
insertImpression.run('late-imp','late','seed-001',1,.5,'test-routing-v1');
// Concurrent requests cannot both commit the same page / frozen opinions.
const racers=await Promise.allSettled([api.continueRelease(id,0),api.continueRelease(id,0)]);
assert.equal(racers.filter(r=>r.status==='fulfilled').length,1);
assert.equal(raw.prepare('SELECT COUNT(*) n FROM release_opinions WHERE release_id=?').get(id).n,1);
release=raw.prepare('SELECT * FROM releases WHERE id=?').get(id);
let calls=1;
while(release.status==='preparing'){release=await api.continueRelease(id,release.build_revision);if(++calls>1000)throw Error('build did not terminate');}
assert.equal(release.status,'draft');
const readPart=async(part)=>{const object=await api.getReleaseObject(id,part);const text=await new Response(object.body).text();assert.equal(await digest(text),object.sha256);assert.equal(Buffer.byteLength(text),object.byteLength);return text;};
const manifest=JSON.parse(await readPart());
assert.equal(manifest.schema_version,3);
assert.equal(manifest.tables.opinions.rows,1);
assert.equal(manifest.tables.responses.rows,128001);
assert.equal(manifest.tables.responses.pages,257);
assert.equal(manifest.tables.presentations.rows,128001);
assert.equal(manifest.tables.presentations.pages,257);
let totalResponses=0,totalResponsePages=0,indexCount=0;
for(let index=manifest.tables.responses.index;index;){const body=await readPart(index.part);assert.equal(await digest(body),index.sha256);const parsed=JSON.parse(body);assert.equal(parsed.pages.length,index.row_count);assert.ok(parsed.pages.length<=256);indexCount++;
 for(const p of parsed.pages){const data=await readPart(p.part);assert.equal(await digest(data),p.sha256);const rows=data.trimEnd().split('\n').map(JSON.parse);assert.equal(rows.length,p.row_count);assert.ok(rows.length<=500);assert.ok(!rows.some(r=>r.session_id==='late'));totalResponses+=rows.length;totalResponsePages++;}
 index=parsed.next;
}
assert.equal(indexCount,2);assert.equal(totalResponses,128001);assert.equal(totalResponsePages,257);
let totalPresentations=0,totalPresentationPages=0,presentationIndexCount=0;
const firstPresentations=[];
for(let index=manifest.tables.presentations.index;index;){const body=await readPart(index.part);assert.equal(await digest(body),index.sha256);const parsed=JSON.parse(body);assert.equal(parsed.pages.length,index.row_count);assert.ok(parsed.pages.length<=256);presentationIndexCount++;
 for(const p of parsed.pages){const data=await readPart(p.part);assert.equal(await digest(data),p.sha256);const rows=data.trimEnd().split('\n').map(JSON.parse);assert.equal(rows.length,p.row_count);assert.ok(rows.length<=500);assert.ok(!rows.some(r=>r.id==='late-imp'));
  for(const row of rows){assert.equal(row.id,'imp-'+(totalPresentations+1));if(totalPresentations<3)firstPresentations.push([row.id,row.displayed,row.answered,row.retired]);totalPresentations++;}
  totalPresentationPages++;
 }
 index=parsed.next;
}
assert.equal(presentationIndexCount,2);assert.equal(totalPresentations,128001);assert.equal(totalPresentationPages,257);
assert.deepEqual(firstPresentations,[['imp-1',true,true,false],['imp-2',false,false,true],['imp-3',false,false,false]]);
await assert.rejects(()=>api.getReleaseObject(id,'d-responses-999999999999'),e=>e.status===404);
const other='22222222-2222-2222-2222-222222222222';
await api.prepareRelease(other,'すすすす','掲載判断変更のテスト','https://github.com/project-test/yokohama-voices-moderation/actions/runs/2');
raw.prepare('UPDATE community_state SET moderation_revision=moderation_revision+1 WHERE id=1').run();
await assert.rejects(()=>api.continueRelease(other),e=>e.status===409);
assert.equal(raw.prepare('SELECT status FROM releases WHERE id=?').get(other).status,'invalidated');
console.log(JSON.stringify({ok:true,responses:totalResponses,responsePages:totalResponsePages,responseIndexPages:indexCount,presentations:totalPresentations,presentationPages:totalPresentationPages,presentationIndexPages:presentationIndexCount,continuations:calls,lateRowsExcluded:true,concurrentCAS:true,epochInvalidation:true}));
} finally {
 delete globalThis.__releaseTest;
 raw.close();
 await fs.rm(temporaryDirectory,{recursive:true,force:true});
}
