import { database } from "@/db/raw";
import { bucket } from "@/lib/releases";
import { digest, opinionQuery } from "@/lib/server";
import { AnalysisAccumulator, analyzeAccumulated, type Analysis, type Vote } from "@/lib/polis-math";
const REFRESH_MS=60_000;
const ALGORITHM="polis-math-v2-covariance-sampled-silhouette";
type State={revision:number;moderation_revision:number;votes:number;sessions:number;highwater:number};
type Cache={snapshot_id:string|null;revision:number;moderation_revision:number;computed_at:number;lease_until:number};
type Snapshot={analysis:Analysis;sessionIds:string[];stats:{sessions:number;votes:number};opinions:Record<string,unknown>[];algorithm:string;sourceRevision:number;moderationRevision:number;computedAt:number};
const processing:Analysis={status:"processing",message:"集計を更新しています。少しお待ちください。",eligible:0,minimum:8,points:[],groups:[],bridges:[]};
async function load(id:string){const object=await bucket().get(`analysis/${id}.json`);return object?await object.json<Snapshot>():null;}
function response(snapshot:Snapshot,id:string,mine?:string,updating=false){
 const index=mine?snapshot.sessionIds.indexOf(mine):-1;
 return {analysis:{...snapshot.analysis,points:snapshot.analysis.points.map((p,i)=>({...p,mine:i===index}))},snapshotId:id,analysisComputedAt:snapshot.computedAt,analysisUpdating:updating,analysisStats:snapshot.stats};
}
/** A single shared immutable snapshot, refreshed on demand at most once/minute.
 * Moderation invalidates immediately. The lease suppresses concurrent rebuilds.
 * Raw session IDs are private and never included in the response. */
export async function sharedAnalysis(mine?:string){
 const db=database(),now=Date.now();
 const state=await db.prepare("SELECT revision,moderation_revision,votes,sessions,(SELECT COALESCE(MAX(rowid),0) FROM votes) highwater FROM community_state WHERE id=1").first<State>();
 if(!state)throw new Error("Missing community state");
 const cache=await db.prepare("SELECT * FROM analysis_cache WHERE id=1").first<Cache>();
 let previous:Snapshot|null=null;
 if(cache?.snapshot_id&&cache.moderation_revision===state.moderation_revision){
  previous=await load(cache.snapshot_id);
  if(previous&&(cache.revision===state.revision||now-cache.computed_at<REFRESH_MS))return response(previous,cache.snapshot_id,mine);
 }
 const lease=crypto.randomUUID();
 const locked=await db.prepare("UPDATE analysis_cache SET lease_token=?,lease_until=? WHERE id=1 AND lease_until<? AND computed_at=? AND revision=? AND snapshot_id IS ?").bind(lease,now+120000,now,cache?.computed_at??0,cache?.revision??-1,cache?.snapshot_id??null).run();
 if(!locked.meta.changes){
  const latest=await db.prepare("SELECT c.*,s.moderation_revision current_moderation FROM analysis_cache c JOIN community_state s ON s.id=c.id WHERE c.id=1").first<Cache & {current_moderation:number}>();
  if(latest?.snapshot_id&&latest.moderation_revision===latest.current_moderation){const value=await load(latest.snapshot_id);if(value)return response(value,latest.snapshot_id,mine,latest.lease_until>now);}
  return {analysis:processing,snapshotId:null,analysisComputedAt:null,analysisUpdating:true,analysisStats:null};
 }
 try{
  // Capture opinion metadata, counts and the append-only vote boundary atomically.
  const [states,opinions]=await db.batch<Record<string,unknown>>([
   db.prepare("SELECT revision,moderation_revision,votes,sessions,(SELECT COALESCE(MAX(rowid),0) FROM votes) highwater FROM community_state WHERE id=1"),
   db.prepare(opinionQuery+" WHERE o.status='approved' ORDER BY o.id")
  ]);
  const source=states.results[0] as unknown as State,acc=new AnalysisAccumulator(opinions.results.map(o=>String(o.id)));
  let after=0;
  while(after<source.highwater){
   const page=await db.prepare("SELECT rowid seq,session_id,opinion_id,CASE WHEN unrelated=1 THEN 2 ELSE value END value FROM votes WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 5000").bind(after,source.highwater).all<Vote & {seq:number}>();
   if(!page.results.length)break;acc.add(page.results);after=page.results.at(-1)!.seq;
  }
  const result=analyzeAccumulated(acc),computedAt=Date.now();
  const payload:Snapshot={...result,stats:{sessions:source.sessions,votes:source.votes},opinions:opinions.results,algorithm:ALGORITHM,sourceRevision:source.revision,moderationRevision:source.moderation_revision,computedAt};
  const bytes=JSON.stringify(payload),id=await digest(bytes);
  await bucket().put(`analysis/${id}.json`,bytes,{httpMetadata:{contentType:"application/json"}});
  const saved=await db.batch<Record<string,unknown>>([
   db.prepare(`INSERT OR IGNORE INTO result_snapshots(id,payload,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM community_state WHERE moderation_revision=?) AND EXISTS(SELECT 1 FROM analysis_cache WHERE id=1 AND lease_token=?)`).bind(id,JSON.stringify({object_key:`analysis/${id}.json`,algorithm:ALGORITHM,sourceRevision:source.revision,moderationRevision:source.moderation_revision}),computedAt,source.moderation_revision,lease),
   db.prepare(`UPDATE analysis_cache SET snapshot_id=?,revision=?,moderation_revision=?,computed_at=?,lease_token=NULL,lease_until=0 WHERE id=1 AND lease_token=? AND EXISTS(SELECT 1 FROM community_state WHERE moderation_revision=?)`).bind(id,source.revision,source.moderation_revision,computedAt,lease,source.moderation_revision)
  ]);
  if(!saved[1].meta.changes)return {analysis:processing,snapshotId:null,analysisComputedAt:null,analysisUpdating:true,analysisStats:null};
  return response(payload,id,mine);
 }finally{await db.prepare("UPDATE analysis_cache SET lease_token=NULL,lease_until=0 WHERE id=1 AND lease_token=?").bind(lease).run();}
}
