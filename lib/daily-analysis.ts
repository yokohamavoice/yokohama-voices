import { database } from "@/db/raw";
import { ensureSeedData } from "@/db/seed";
import { bucket } from "@/lib/releases";
import { requireCounters } from "@/lib/counters";
import { digest, opinionQuery } from "@/lib/server";
import { AnalysisAccumulator, analyzeAccumulated, DEFAULT_ANALYSIS_OPTIONS, type Analysis, type AnalysisOptions, type ProjectionModel, type Vote } from "@/lib/polis-math";
import { ANALYSIS_ALGORITHM, matchesAnalysisConfiguration } from "@/lib/analysis-cache-identity";

type State={revision:number;moderation_revision:number;votes:number;sessions:number;highwater:number};
type Cache={snapshot_id:string|null;revision:number;moderation_revision:number;computed_at:number;lease_until:number;completed_day:string|null};
type Snapshot={analysis:Analysis;model:ProjectionModel|null;sessionIds:string[];stats:{sessions:number;votes:number};opinions:Record<string,unknown>[];algorithm:string;parameters:AnalysisOptions;sourceRevision:number;moderationRevision:number;computedAt:number};
type Head=Cache & {current_moderation:number;payload:string|null};
const waiting:Analysis={status:"waiting",message:"全体分析は毎日午前3時（日本時間）に更新します。次の集計をお待ちください。",eligible:0,minimum:DEFAULT_ANALYSIS_OPTIONS.minSessions,points:[],groups:[],bridges:[]};
const absent=(updating=false)=>({analysis:waiting,projectionModel:null,snapshotId:null,analysisComputedAt:null,analysisUpdating:updating,analysisStats:null,analysisOpinions:[]});
async function load(id:string){const object=await bucket().get(`analysis/${id}.json`);return object?await object.json<Snapshot>():null;}
function configurationMatches(snapshot:Parameters<typeof matchesAnalysisConfiguration>[0]){return matchesAnalysisConfiguration(snapshot,DEFAULT_ANALYSIS_OPTIONS);}
function manifestMatches(payload:string|null){try{return !!payload&&configurationMatches(JSON.parse(payload));}catch{return false;}}
function response(snapshot:Snapshot,id:string,mine?:string,updating=false){
 const index=mine?snapshot.sessionIds.indexOf(mine):-1;
 return {analysis:{...snapshot.analysis,points:snapshot.analysis.points.map((p,i)=>({...p,mine:i===index}))},projectionModel:snapshot.model,snapshotId:id,analysisComputedAt:snapshot.computedAt,analysisUpdating:updating,analysisStats:snapshot.stats,analysisOpinions:snapshot.opinions.map(p=>({...p,sourceIds:JSON.parse(String(p.sourceIds))}))};
}

/** Read a completed daily map. Public requests never scan votes or fit a model.
 * The manifest makes unchanged polls one small D1 read, without an R2 download.
 * Private participant IDs and warm-start diagnostics never leave this module. */
export async function sharedAnalysis(mine?:string,knownSnapshot?:string){
 const db=database();
 const head=await db.prepare(`SELECT c.*,s.moderation_revision current_moderation,r.payload
  FROM analysis_cache c JOIN community_state s ON s.id=c.id
  LEFT JOIN result_snapshots r ON r.id=c.snapshot_id WHERE c.id=1`).first<Head>();
 if(!head)throw new Error("Missing analysis state");
 const updating=head.lease_until>Date.now();
 if(!head.snapshot_id||head.moderation_revision!==head.current_moderation||!manifestMatches(head.payload))return absent(updating);
 if(knownSnapshot===head.snapshot_id)return {analysisUnchanged:true as const,snapshotId:head.snapshot_id,analysisComputedAt:head.computed_at,analysisUpdating:updating};
 const snapshot=await load(head.snapshot_id);
 if(!snapshot||!configurationMatches(snapshot)||snapshot.moderationRevision!==head.current_moderation)return absent(updating);
 // A moderation action may have completed while the R2 object was in flight.
 const current=await db.prepare("SELECT moderation_revision FROM community_state WHERE id=1").first<{moderation_revision:number}>();
 if(current?.moderation_revision!==snapshot.moderationRevision)return absent(updating);
 return response(snapshot,head.snapshot_id,mine,updating);
}

/** Daily 03:00 JST scheduled job. A day marker and lease coalesce retries; the
 * last completed map remains available during ordinary updates or failures.
 * A changed moderation/configuration revision is always hidden by the reader. */
export async function runDailyAnalysis(scheduledTime=Date.now()){
 if(!Number.isFinite(scheduledTime))throw new Error("Invalid scheduled time");
 const day=new Date(scheduledTime+9*60*60*1000).toISOString().slice(0,10);
 await requireCounters();await ensureSeedData();
 const db=database(),now=Date.now();
 const cache=await db.prepare("SELECT * FROM analysis_cache WHERE id=1").first<Cache>();
 if(!cache)throw new Error("Missing analysis cache");
 if(cache.completed_day&&cache.completed_day>=day)return {status:"already-completed",day};
 const lease=crypto.randomUUID();
 // Scheduled Workers have at most 15 minutes of wall time; let a dead worker's
 // lease expire after that limit so overlapping retries cannot publish twice.
 const locked=await db.prepare(`UPDATE analysis_cache SET lease_token=?,lease_until=?
  WHERE id=1 AND lease_until<=? AND computed_at=? AND revision=? AND snapshot_id IS ? AND completed_day IS ?`)
  .bind(lease,now+16*60*1000,now,cache.computed_at,cache.revision,cache.snapshot_id,cache.completed_day).run();
 if(!locked.meta.changes)return {status:"busy",day};
 try{
  const [states,opinions]=await db.batch<Record<string,unknown>>([
   db.prepare("SELECT revision,moderation_revision,votes,sessions,(SELECT COALESCE(MAX(rowid),0) FROM votes) highwater FROM community_state WHERE id=1"),
   db.prepare(opinionQuery+" WHERE o.status='approved' ORDER BY o.id")
  ]);
  const source=states.results[0] as unknown as State;
  const previous=cache.snapshot_id?await load(cache.snapshot_id):null;
  const reusable=previous&&configurationMatches(previous);
  if(reusable&&cache.revision===source.revision&&cache.moderation_revision===source.moderation_revision){
   const saved=await db.prepare(`UPDATE analysis_cache SET completed_day=? WHERE id=1 AND lease_token=?
    AND EXISTS(SELECT 1 FROM community_state WHERE id=1 AND moderation_revision=?)`).bind(day,lease,source.moderation_revision).run();
   return {status:saved.meta.changes?"unchanged":"superseded",day};
  }
  const acc=new AnalysisAccumulator(opinions.results.map(o=>String(o.id)));
  let after=0;
  while(after<source.highwater){
   const page=await db.prepare("SELECT rowid seq,session_id,opinion_id,CASE WHEN unrelated=1 THEN 2 ELSE value END value FROM votes WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 5000").bind(after,source.highwater).all<Vote & {seq:number}>();
   if(!page.results.length)break;acc.add(page.results);after=page.results.at(-1)!.seq;
  }
  const warm=reusable&&previous.model?{model:previous.model,sessionIds:previous.sessionIds,groups:previous.analysis.points.map(p=>p.group)}:undefined;
  const result=analyzeAccumulated(acc,DEFAULT_ANALYSIS_OPTIONS,warm),computedAt=Date.now();
  const payload:Snapshot={...result,stats:{sessions:source.sessions,votes:source.votes},opinions:opinions.results,algorithm:ANALYSIS_ALGORITHM,parameters:DEFAULT_ANALYSIS_OPTIONS,sourceRevision:source.revision,moderationRevision:source.moderation_revision,computedAt};
  const bytes=JSON.stringify(payload),id=await digest(bytes);
  await bucket().put(`analysis/${id}.json`,bytes,{httpMetadata:{contentType:"application/json"}});
  // Snapshot + pointer commit together, fenced by the lease and moderation
  // revision. New votes can wait for tomorrow; withdrawn opinions cannot leak.
  const manifest=JSON.stringify({object_key:`analysis/${id}.json`,algorithm:ANALYSIS_ALGORITHM,parameters:DEFAULT_ANALYSIS_OPTIONS,sourceRevision:source.revision,moderationRevision:source.moderation_revision});
  const saved=await db.batch<Record<string,unknown>>([
   db.prepare(`INSERT OR IGNORE INTO result_snapshots(id,payload,created_at) SELECT ?,?,?
    WHERE EXISTS(SELECT 1 FROM community_state WHERE id=1 AND moderation_revision=?)
    AND EXISTS(SELECT 1 FROM analysis_cache WHERE id=1 AND lease_token=?)`).bind(id,manifest,computedAt,source.moderation_revision,lease),
   db.prepare(`UPDATE analysis_cache SET snapshot_id=?,revision=?,moderation_revision=?,computed_at=?,completed_day=?,lease_token=NULL,lease_until=0
    WHERE id=1 AND lease_token=? AND EXISTS(SELECT 1 FROM community_state WHERE id=1 AND moderation_revision=?)`)
    .bind(id,source.revision,source.moderation_revision,computedAt,day,lease,source.moderation_revision)
  ]);
  return {status:saved[1].meta.changes?"updated":"superseded",day};
 }finally{await db.prepare("UPDATE analysis_cache SET lease_token=NULL,lease_until=0 WHERE id=1 AND lease_token=?").bind(lease).run();}
}
