import { requireCounters } from "@/lib/counters";
import { sharedAnalysis } from "@/lib/daily-analysis";
import { getSession, json } from "@/lib/server";

export const dynamic="force-dynamic";
export async function GET(req:Request){try{
 await requireCounters();
 const session=await getSession(req),known=new URL(req.url).searchParams.get("snapshot")||undefined;
 return json(await sharedAnalysis(session?.id,known));
}catch(e){console.error("daily analysis read failed",e);return json({error:"地図を読み込めませんでした。しばらくしてからお試しください。"},503);}}
