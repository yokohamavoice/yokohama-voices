import { database } from "@/db/raw";
import { HttpError } from "@/lib/server";
export async function requireCounters(){
 const row=await database().prepare("SELECT ready FROM community_state WHERE id=1").first<{ready:number}>();
 if(!row?.ready)throw new HttpError(503,"集計の準備中です。しばらくしてからお試しください。");
}
/** Explicit administrator maintenance. Repeated/concurrent calls are safe;
 * visitor writes remain gated for the entire backfill, including old retirements. */
export async function initializeCounters(){
 const db=database(),s=await db.prepare("SELECT * FROM community_state WHERE id=1").first<{ready:number;backfill_phase:string;backfill_cursor:number}>();
 if(!s)throw new HttpError(503,"データベースの更新が必要です。");if(s.ready)return s;
 const phase=s.backfill_phase,cursor=s.backfill_cursor;
 const table=phase==="opinions"?"opinions":phase==="sessions"?"sessions":"impressions";
 const rows=await db.prepare(`SELECT rowid AS seq,id FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 25`).bind(cursor).all<{seq:number;id:string}>();
 const statements=rows.results.map(row=>phase==="opinions"?db.prepare(`UPDATE opinions SET
 agree_count=(SELECT COUNT(*) FROM votes WHERE opinion_id=? AND unrelated=0 AND value=-1),
 disagree_count=(SELECT COUNT(*) FROM votes WHERE opinion_id=? AND unrelated=0 AND value=1),
 pass_count=(SELECT COUNT(*) FROM votes WHERE opinion_id=? AND unrelated=0 AND value=0),
 unrelated_count=(SELECT COUNT(*) FROM votes WHERE opinion_id=? AND unrelated=1) WHERE id=?
 AND EXISTS(SELECT 1 FROM community_state WHERE ready=0 AND backfill_phase=? AND backfill_cursor=?)`).bind(row.id,row.id,row.id,row.id,row.id,phase,cursor):phase==="sessions"?db.prepare(`UPDATE sessions SET approved_vote_count=(SELECT COUNT(*) FROM votes v JOIN opinions o ON o.id=v.opinion_id WHERE v.session_id=? AND o.status='approved') WHERE id=? AND EXISTS(SELECT 1 FROM community_state WHERE ready=0 AND backfill_phase=? AND backfill_cursor=?)`).bind(row.id,row.id,phase,cursor):db.prepare(`INSERT OR IGNORE INTO events(id,session_id,type,impression_id,created_at) SELECT 'retired:'||id,session_id,'retired',id,retired_at FROM impressions WHERE id=? AND retired_at IS NOT NULL`).bind(row.id));
 const nextPhase=rows.results.length===25?phase:phase==="opinions"?"sessions":phase==="sessions"?"impressions":"done";
 statements.push(db.prepare("UPDATE community_state SET backfill_phase=?,backfill_cursor=? WHERE id=1 AND ready=0 AND backfill_phase=? AND backfill_cursor=?").bind(nextPhase,nextPhase===phase?rows.results.at(-1)!.seq:0,phase,cursor));
 if(nextPhase==="done")statements.push(db.prepare(`UPDATE community_state SET votes=(SELECT COALESCE(SUM(agree_count+disagree_count+pass_count+unrelated_count),0) FROM opinions WHERE status='approved'),sessions=(SELECT COUNT(*) FROM sessions WHERE approved_vote_count>0),revision=revision+1,ready=1 WHERE id=1 AND ready=0 AND backfill_phase='done'`));
 await db.batch(statements);return db.prepare("SELECT * FROM community_state WHERE id=1").first();
}
