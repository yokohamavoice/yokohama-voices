import { requireCounters } from "@/lib/counters";
import { database } from "@/db/raw";
import seed from "@/data/seed.json";
import { ensureSeedData } from "@/db/seed";
import { sharedAnalysis } from "@/lib/analysis-cache";
import { json, getSession, opinionQuery } from "@/lib/server";
export { POST } from "../session/route";
export const dynamic="force-dynamic";
export async function GET(req:Request){try{
 await requireCounters();await ensureSeedData();const db=database(),s=await getSession(req);
 const posts=await db.prepare(opinionQuery+" WHERE o.status='approved' ORDER BY o.created_at DESC,o.id ASC").all();
 const own=s?await db.prepare("SELECT opinion_id,CASE WHEN unrelated=1 THEN 2 ELSE value END AS value FROM votes WHERE session_id=?").bind(s.id).all():{results:[]};
 const mine=s?await db.prepare("SELECT id,status FROM opinions WHERE author_session=?").bind(s.id).all():{results:[]};
 const stats=await db.prepare("SELECT sessions,votes FROM community_state WHERE id=1").first();
 const result=new URL(req.url).searchParams.get("analysis")==="1"?await sharedAnalysis(s?.id):{analysis:null,snapshotId:null};
 return json({opinions:posts.results.map(p=>({...p,sourceIds:JSON.parse(String(p.sourceIds))})),tags:seed.tags,sources:seed.sources,meta:seed.meta,stats,session:s?{phase:s.phase,votes:Object.fromEntries(own.results.map(v=>[v.opinion_id,v.value])),posts:mine.results.map(p=>p.id),postStatuses:mine.results}:null,...result});
 }catch(e){console.error("community read failed",e);return json({error:"読み込みに失敗しました。少し待って、もう一度お試しください。"},503);}}
