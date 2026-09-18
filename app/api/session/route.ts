import { requireCounters } from "@/lib/counters";
import { database } from "@/db/raw";
import seed from "@/data/seed.json";
import { ensureSeedData } from "@/db/seed";
import { json, getSession, digest, bodyOf, validId, HttpError, opinionQuery } from "@/lib/server";
import { ROUTING_VERSION, distribution, draw, type RoutingCandidate } from "@/lib/routing";
import { NOTICE_VERSION } from "@/lib/public-data";
export const dynamic="force-dynamic";
type Impression={id:string;opinion_id:string;sequence:number;text_snapshot:string;tag_snapshot:string;source_snapshot:string;kind_snapshot:string;probability:number;routing_version:string};
function delivery(i:Impression){return {id:i.id,sequence:i.sequence,probability:i.probability,routingVersion:i.routing_version,opinion:{id:i.opinion_id,text:i.text_snapshot,tagId:JSON.parse(i.tag_snapshot).id,sourceIds:JSON.parse(i.source_snapshot),kind:i.kind_snapshot}};}
async function next(sessionId:string){
 const db=database();
 await db.prepare("UPDATE impressions SET retired_at=? WHERE session_id=? AND answered_at IS NULL AND retired_at IS NULL AND opinion_id IN (SELECT id FROM opinions WHERE status!='approved')").bind(Date.now(),sessionId).run();
 const outstanding=async()=>db.prepare("SELECT * FROM impressions WHERE session_id=? AND answered_at IS NULL AND retired_at IS NULL ORDER BY sequence DESC LIMIT 1").bind(sessionId).first<Impression>();
 const old=await outstanding();if(old)return delivery(old);
 const rows=await db.prepare(opinionQuery+" WHERE o.status='approved' AND (o.author_session IS NULL OR o.author_session!=?) AND NOT EXISTS (SELECT 1 FROM votes own WHERE own.session_id=? AND own.opinion_id=o.id) ORDER BY o.id").bind(sessionId,sessionId).all<RoutingCandidate & {text:string;kind:string;sourceIds:string}>();
 const history=await db.prepare("SELECT tag_snapshot,COUNT(*) n FROM impressions WHERE session_id=? GROUP BY tag_snapshot").bind(sessionId).all<{tag_snapshot:string;n:number}>();
 const issuedByTag=Object.fromEntries(history.results.map(r=>[JSON.parse(r.tag_snapshot).id,r.n]));
 const candidates=rows.results.map(o=>({id:o.id,tagId:o.tagId,agree:Number(o.agree),disagree:Number(o.disagree),pass:Number(o.pass),unrelated:Number(o.unrelated)}));
 const probabilities=distribution(candidates,issuedByTag),selection=draw(probabilities,crypto.getRandomValues(new Uint32Array(1))[0]/4294967296);
 if(!selection)return null;
 const o=rows.results.find(o=>o.id===selection.id)!,id=crypto.randomUUID(),now=Date.now();
 const snapshot=JSON.stringify({version:ROUTING_VERSION,issuedByTag,candidates,probabilities});
 if(snapshot.length>1500000)throw new HttpError(503,"意見が増えたため、表示方法の調整が必要です。");
 try{await db.prepare(`INSERT INTO impressions(id,session_id,opinion_id,sequence,text_snapshot,tag_snapshot,source_snapshot,kind_snapshot,routing_version,probability,candidates,issued_at)
 SELECT ?,?,?,COALESCE((SELECT MAX(sequence) FROM impressions WHERE session_id=?),0)+1,?,?,?,?,?,?,?,?
 WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND phase='active') AND EXISTS(SELECT 1 FROM opinions WHERE id=? AND status='approved')
 AND NOT EXISTS(SELECT 1 FROM votes WHERE session_id=? AND opinion_id=?)
 AND NOT EXISTS(SELECT 1 FROM impressions WHERE session_id=? AND answered_at IS NULL AND retired_at IS NULL)`)
 .bind(id,sessionId,o.id,sessionId,o.text,JSON.stringify(seed.tags.find(t=>t.id===o.tagId)),o.sourceIds,o.kind,ROUTING_VERSION,selection.probability,snapshot,now,sessionId,o.id,sessionId,o.id,sessionId).run();
 }catch(e){if(!String(e).includes("UNIQUE"))throw e;}
 const allocated=await outstanding();if(!allocated)throw new HttpError(409,"表示する意見が更新されました。もう一度お試しください。");return delivery(allocated);
}
export async function POST(req:Request){try{
 const origin=req.headers.get("origin");if(origin&&origin!==new URL(req.url).origin)throw new HttpError(403,"この画面から操作してください。");
 const token=req.headers.get("x-session-token");if(!token||!/^[a-f0-9]{64}$/.test(token))throw new HttpError(401,"セッションが確認できません。画面を再読み込みしてください。");
 const b=await bodyOf(req);await requireCounters();await ensureSeedData();const db=database(),now=Date.now();let s=await getSession(req);
 if(b.action==="start"){
  if(b.noticeVersion!==NOTICE_VERSION)throw new HttpError(409,"案内を更新しました。画面を再読み込みしてください。");
  await db.prepare("INSERT OR IGNORE INTO sessions(id,token_hash,phase,created_at,notice_version,last_seen_at) VALUES(?,?,'active',?,?,?)").bind(crypto.randomUUID(),await digest(token),now,NOTICE_VERSION,now).run();
  s=await getSession(req);
  if(s&&s.notice_version!==NOTICE_VERSION)await db.prepare("UPDATE sessions SET notice_version=? WHERE id=?").bind(NOTICE_VERSION,s.id).run();
  if(s)await db.prepare("INSERT OR IGNORE INTO events(id,session_id,type,created_at) VALUES(?,?,?,?)").bind(`notice:${s.id}:${NOTICE_VERSION}`,s.id,"notice_presented",now).run();
  return json({ok:true});
 }
 if(!s)throw new HttpError(401,"画面を再読み込みしてから操作してください。");
 if(b.action==="next"){if(s.phase!=="active")return json({impression:null});return json({impression:await next(s.id)});}
 if(b.action==="event"){
  if(!validId(b.id)||!["shown","results_view","browse_view","page_hidden","page_visible","page_exit","answer_view"].includes(b.type))throw new HttpError(400,"記録内容を確認してください。");
  if(b.impressionId&&!await db.prepare("SELECT id FROM impressions WHERE id=? AND session_id=?").bind(b.impressionId,s.id).first())throw new HttpError(400,"表示履歴を確認してください。");
  if(b.type==="shown"&&!b.impressionId)throw new HttpError(400,"表示履歴がありません。");
  if(b.type==="results_view"&&(!b.snapshotId||!await db.prepare("SELECT id FROM result_snapshots WHERE id=?").bind(b.snapshotId).first()))throw new HttpError(400,"集計結果を確認してください。");
  const statements=[db.prepare("INSERT OR IGNORE INTO events(id,session_id,type,impression_id,snapshot_id,created_at,client_at,client_sequence) VALUES(?,?,?,?,?,?,?,?)").bind(b.id,s.id,b.type,b.impressionId||null,b.type==="results_view"?b.snapshotId:null,now,Number.isSafeInteger(b.clientAt)?b.clientAt:null,Number.isSafeInteger(b.clientSequence)?b.clientSequence:null),db.prepare("UPDATE sessions SET last_seen_at=? WHERE id=?").bind(now,s.id)];
  if(b.type==="shown")statements.push(db.prepare("UPDATE impressions SET displayed_at=COALESCE(displayed_at,?) WHERE id=? AND session_id=?").bind(now,b.impressionId,s.id));
  await db.batch(statements);return json({ok:true});
 }
 if(b.action==="vote"){
  if(![-1,0,1,2].includes(b.value)||typeof b.opinionId!=="string"||!validId(b.impressionId))throw new HttpError(400,"回答を確認してください。");
  const i=await db.prepare("SELECT * FROM impressions WHERE id=? AND session_id=? AND opinion_id=?").bind(b.impressionId,s.id,b.opinionId).first();
  if(!i)throw new HttpError(400,"このセッションで表示した意見に回答してください。");
  const prev=await db.prepare("SELECT CASE WHEN unrelated=1 THEN 2 ELSE value END value FROM votes WHERE session_id=? AND opinion_id=?").bind(s.id,b.opinionId).first<{value:number}>();
  if(prev){if(prev.value===b.value)return json({ok:true});throw new HttpError(409,"この意見にはすでに回答しています。");}
  if(s.phase!=="active")throw new HttpError(409,"回答セッションは終了しています。");
  const op=await db.prepare("SELECT id,author_session FROM opinions WHERE id=? AND status='approved'").bind(b.opinionId).first();
  if(!op||i.retired_at)throw new HttpError(409,"この意見は確認のため表示を止めています。再読み込みしてください。");
  if(op.author_session===s.id)throw new HttpError(400,"自分の投稿への回答はできません。");
  const out=await db.batch([
   db.prepare("INSERT OR IGNORE INTO votes(session_id,opinion_id,value,unrelated,created_at,impression_id) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sessions WHERE id=? AND phase='active') AND EXISTS(SELECT 1 FROM opinions WHERE id=? AND status='approved')").bind(s.id,b.opinionId,b.value===2?0:b.value,b.value===2?1:0,now,b.impressionId,s.id,b.opinionId),
   db.prepare("UPDATE impressions SET answered_at=? WHERE id=? AND EXISTS(SELECT 1 FROM votes WHERE impression_id=?)").bind(now,b.impressionId,b.impressionId),
   db.prepare("UPDATE sessions SET last_seen_at=? WHERE id=?").bind(now,s.id)
  ]);
  if(!out[0].meta.changes)throw new HttpError(409,"回答状態が変わりました。再読み込みしてください。");return json({ok:true});
 }
 if(b.action==="finish"||b.action==="end"){
  const phase=b.action==="finish"?"reflect":"ended";
  await db.batch([
   db.prepare("UPDATE sessions SET phase=?,ended_at=CASE WHEN ?='ended' THEN COALESCE(ended_at,?) ELSE ended_at END,last_seen_at=? WHERE id=? AND phase!='ended'").bind(phase,phase,now,now,s.id),
   db.prepare("INSERT OR IGNORE INTO events(id,session_id,type,impression_id,created_at) VALUES(?,?,?,(SELECT id FROM impressions WHERE session_id=? ORDER BY sequence DESC LIMIT 1),?)").bind(`${b.action}:${s.id}`,s.id,b.action,s.id,now)
  ]);return json({ok:true});
 }
 if(b.action==="post"){
  if(s.phase!=="reflect")throw new HttpError(409,"回答を終えてから投稿してください。");
  if(!validId(b.id))throw new HttpError(400,"投稿を確認してください。");
  const existing=await db.prepare("SELECT author_session FROM opinions WHERE id=?").bind(b.id).first();if(existing){if(existing.author_session===s.id)return json({ok:true,id:b.id});throw new HttpError(409,"投稿を確認してください。");}
  const content=typeof b.text==="string"?b.text.trim():"";
  if(content.length<8||content.length>280||!seed.tags.some(t=>t.id===b.tagId))throw new HttpError(400,"分野を選び、意見を8〜280文字で入力してください。");
  const result=await db.prepare("INSERT INTO opinions(id,tag_id,text,kind,author_session,source_ids,created_at,status) SELECT ?,?,?,'participant',?,'[]',?,'pending' WHERE (SELECT COUNT(*) FROM opinions WHERE author_session=?)<3 AND EXISTS(SELECT 1 FROM sessions WHERE id=? AND phase='reflect')").bind(b.id,b.tagId,content,s.id,now,s.id,s.id).run();
  if(!result.meta.changes)throw new HttpError(409,"1セッションで投稿できる意見は3件までです。");return json({ok:true,id:b.id,status:"pending"});
 }
 if(b.action==="report"){
  if(typeof b.opinionId!=="string"||!["personal_information","abuse","duplicate","other"].includes(b.category))throw new HttpError(400,"通報の種類を選んでください。");
  if(!await db.prepare("SELECT id FROM opinions WHERE id=? AND status='approved'").bind(b.opinionId).first())throw new HttpError(404,"この意見は現在表示されていません。");
  await db.prepare("INSERT OR IGNORE INTO reports(id,session_id,opinion_id,category,created_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(),s.id,b.opinionId,b.category,now).run();return json({ok:true});
 }
 throw new HttpError(400,"操作を確認してください。");
 }catch(e){if(e instanceof HttpError)return json({error:e.message},e.status);console.error("session write failed",e);return json({error:"保存できませんでした。入力はそのままで、もう一度お試しください。"},503);}}
