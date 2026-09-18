import { validateModerationIdentity } from "@/lib/moderation-identity";
import { initializeCounters, requireCounters } from "@/lib/counters";
import { env } from "cloudflare:workers";
import { database } from "@/db/raw";
import { ensureSeedData } from "@/db/seed";
import { bodyOf, digest, HttpError, json, opinionQuery, validId } from "@/lib/server";
import { bucket, prepareRelease, continueRelease, getReleaseObject } from "@/lib/releases";
export const dynamic="force-dynamic";
const THRESHOLD=3;
async function authorize(req:Request){
 if(!env.MODERATION_TOKEN)throw new HttpError(503,"管理機能はまだ設定されていません。");
 const header=req.headers.get("authorization")||"";
 if(!header.startsWith("Bearer ")||await digest(header.slice(7))!==await digest(env.MODERATION_TOKEN))throw new HttpError(401,"管理者の認証が必要です。");
}
const fail=(e:unknown)=>{if(e instanceof HttpError)return json({error:e.message},e.status);console.error("moderation failed",e);return json({error:"管理操作に失敗しました。"},503);};
export async function GET(req:Request){try{
 await authorize(req);await ensureSeedData();const db=database(),url=new URL(req.url);
 if(url.searchParams.get("view")==="draft"){
  const object=await getReleaseObject(url.searchParams.get("id")||"",url.searchParams.get("part")||undefined);
  return new Response(object.body,{headers:{"Content-Type":object.contentType,"Cache-Control":"no-store","X-Content-SHA256":object.sha256}});
 }
 if(url.searchParams.get("view")==="analysis"){
  const snapshotId=url.searchParams.get("id")||"";if(!/^[a-f0-9]{64}$/.test(snapshotId))throw new HttpError(400,"集計結果を確認してください。");
  const row=await db.prepare("SELECT payload FROM result_snapshots WHERE id=?").bind(snapshotId).first<{payload:string}>();if(!row)throw new HttpError(404,"集計結果が見つかりません。");
  const payload=JSON.parse(row.payload);if(!payload.object_key)return json(payload);
  const object=await bucket().get(payload.object_key);if(!object)throw new HttpError(503,"集計結果を取得できません。");return new Response(object.body,{headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
 }
 if(url.searchParams.get("view")==="raw"){
  const table=url.searchParams.get("table")||"",after=Number(url.searchParams.get("after")||0);
  const fields:Record<string,string>={sessions:"id,phase,created_at,ended_at,notice_version,last_seen_at",impressions:"*",events:"*",votes:"*",opinions:"*",result_snapshots:"*",moderation_actions:"*",reports:"*"};
  if(!Object.hasOwn(fields,table)||!Number.isSafeInteger(after)||after<0)throw new HttpError(400,"取得条件を確認してください。");
  const rows=await db.prepare(`SELECT rowid AS cursor,${fields[table]} FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 100`).bind(after).all<{cursor:number}>();
  return json({table,rows:rows.results,next:rows.results.length===100?rows.results.at(-1)!.cursor:null});
 }
 // Queue-only fields stay behind administrator authentication.
 const all=await db.prepare(opinionQuery+" ORDER BY o.created_at,o.id").all<Record<string,unknown>>();
 const metadata=await db.prepare("SELECT o.id,o.reviewed_unrelated,o.reviewed_reports,COUNT(r.id) reports FROM opinions o LEFT JOIN reports r ON r.opinion_id=o.id GROUP BY o.id").all<Record<string,unknown>>();
 const meta=new Map(metadata.results.map(o=>[o.id,o]));
 const items:Record<string,unknown>[]=all.results.map(o=>({...o,...meta.get(o.id),sourceIds:JSON.parse(String(o.sourceIds))}));
 const actions=await db.prepare("SELECT * FROM moderation_actions ORDER BY created_at DESC LIMIT 100").all();
 const releases=await db.prepare("SELECT id,sha256,status,created_at,published_at,summary,reason FROM releases ORDER BY created_at DESC LIMIT 50").all();
 const reportCounts=await db.prepare("SELECT opinion_id,category,COUNT(*) count FROM reports GROUP BY opinion_id,category").all();
 return json({threshold:THRESHOLD,generated_at:new Date().toISOString(),queue:items.filter(o=>o.status==="pending"||(o.status==="approved"&&(Number(o.unrelated)-Number(o.reviewed_unrelated)>=THRESHOLD||Number(o.reports)>Number(o.reviewed_reports)))),hidden:items.filter(o=>o.status==="hidden"||o.status==="rejected"),actions:actions.results,releases:releases.results,report_categories:reportCounts.results});
 }catch(e){return fail(e);}}
export async function POST(req:Request){try{
 await authorize(req);const b=await bodyOf(req),db=database();
 if(!validId(b.id)||typeof b.reason!=="string"||b.reason.trim().length<2||b.reason.length>500)throw new HttpError(400,"操作IDと理由を確認してください。");
 validateModerationIdentity(b.actor,b.runUrl,b.action,req.url);
 if(b.action==="initialize_counts")return json({ok:true,state:await initializeCounters()});
 await requireCounters();
 if(b.action==="prepare_release")return json({ok:true,release:await prepareRelease(b.id,b.actor,b.reason.trim(),b.runUrl)});
 if(b.action==="continue_release"){if(!validId(b.releaseId))throw new HttpError(400,"公開候補IDを確認してください。");return json({ok:true,release:await continueRelease(b.releaseId,b.expectedRevision)});}
 if(b.action==="publish_release"){
  if(!validId(b.releaseId)||typeof b.sha256!=="string")throw new HttpError(400,"公開候補と照合値を確認してください。");
  const r=await db.prepare("SELECT * FROM releases WHERE id=?").bind(b.releaseId).first<{status:string;sha256:string;opinion_revisions:string;object_key:string;schema_version:number;moderation_revision:number}>();
  if(!r||r.sha256!==b.sha256)throw new HttpError(409,"確認した公開候補と一致しません。");
  if(r.status==="released")return json({ok:true,releaseId:b.releaseId});
  if(r.status!=="draft")throw new HttpError(409,"公開候補が完成していないか、掲載判断が変わっています。");
  const object=await bucket().get(r.object_key);if(!object||await digest(await object.text())!==r.sha256)throw new HttpError(409,"候補データの照合に失敗しました。");
  const update=await db.prepare(`UPDATE releases SET status='released',published_at=?,publish_run_url=?,publication_reason=? WHERE id=? AND status='draft'
   AND (schema_version=2 OR moderation_revision=(SELECT moderation_revision FROM community_state WHERE id=1))
   AND NOT EXISTS(SELECT 1 FROM json_each(?) r LEFT JOIN opinions o ON o.id=r.key WHERE o.id IS NULL OR o.status!='approved' OR o.revision!=r.value)`)
   .bind(Date.now(),b.runUrl,b.reason.trim(),b.releaseId,r.opinion_revisions).run();
  if(!update.meta.changes)throw new HttpError(409,"候補の作成後に投稿の判断が変わりました。候補を作り直してください。");return json({ok:true,releaseId:b.releaseId});
 }
 const transitions:Record<string,{from:string[];to:string|null}>={approve:{from:["pending"],to:"approved"},reject:{from:["pending"],to:"rejected"},hide:{from:["approved"],to:"hidden"},restore:{from:["hidden","rejected"],to:"approved"},keep:{from:["approved"],to:null}};
 const rule=Object.hasOwn(transitions,b.action)?transitions[b.action]:null;
 if(!Number.isInteger(b.reviewedUnrelated)||b.reviewedUnrelated<0||!Number.isInteger(b.reviewedReports)||b.reviewedReports<0)throw new HttpError(400,"一覧の確認コードを入力してください。");
 if(!rule||typeof b.opinionId!=="string"||!Number.isInteger(b.expectedRevision)||b.expectedRevision<0)throw new HttpError(400,"投稿ID・判断・現在の版を確認してください。");
 const done=await db.prepare("SELECT opinion_id,action,reason FROM moderation_actions WHERE id=?").bind(b.id).first();
 if(done){if(done.opinion_id!==b.opinionId||done.action!==b.action||done.reason!==b.reason.trim())throw new HttpError(409,"操作IDが別の判断に使われています。");return json({ok:true});}
 const o=await db.prepare("SELECT id,status,revision FROM opinions WHERE id=?").bind(b.opinionId).first<{id:string;status:string;revision:number}>();
 if(!o)throw new HttpError(404,"投稿が見つかりません。");if(o.revision!==b.expectedRevision||!rule.from.includes(o.status))throw new HttpError(409,"投稿の状態が変わりました。確認一覧を更新してください。");
 const nextStatus=rule.to||o.status,now=Date.now();
 const results=await db.batch([
  db.prepare(`INSERT INTO moderation_actions(id,opinion_id,action,reason,actor,run_url,previous_status,next_status,revision,created_at)
   SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM opinions WHERE id=? AND revision=?)`).bind(b.id,o.id,b.action,b.reason.trim(),b.actor,b.runUrl,o.status,nextStatus,o.revision+1,now,o.id,o.revision),
  db.prepare(`UPDATE opinions SET status=?,revision=revision+1,reviewed_unrelated=MAX(reviewed_unrelated,MIN(?,unrelated_count)),reviewed_reports=MAX(reviewed_reports,MIN(?,(SELECT COUNT(*) FROM reports WHERE opinion_id=opinions.id)))
   WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM moderation_actions WHERE id=?)`).bind(nextStatus,b.reviewedUnrelated,b.reviewedReports,o.id,o.revision,b.id),
  db.prepare("UPDATE impressions SET retired_at=? WHERE opinion_id=? AND answered_at IS NULL AND retired_at IS NULL AND EXISTS(SELECT 1 FROM opinions WHERE id=? AND status!='approved')").bind(now,o.id,o.id)
 ]);
 if(!results[0].meta.changes)throw new HttpError(409,"別の判断が先に保存されました。確認一覧を更新してください。");
 return json({ok:true,status:nextStatus,revision:o.revision+1});
 }catch(e){return fail(e);}}
