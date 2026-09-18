import { HttpError } from "@/lib/server";
import { database } from "@/db/raw";
import { getReleaseObject } from "@/lib/releases";
export const dynamic="force-dynamic";
const headers={"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Access-Control-Allow-Origin":"*","Access-Control-Expose-Headers":"X-Content-SHA256","X-Content-Type-Options":"nosniff"};
export async function GET(req:Request){try{
 const url=new URL(req.url);
 if(url.searchParams.get("list")==="1"){const all=await database().prepare("SELECT id,sha256,published_at FROM releases WHERE status='released' ORDER BY published_at,id").all();return Response.json({releases:all.results},{headers});}
 const id=url.searchParams.get("release");
 const release=await (id?database().prepare("SELECT id,object_key,sha256 FROM releases WHERE status='released' AND id=?").bind(id):database().prepare("SELECT id,object_key,sha256 FROM releases WHERE status='released' ORDER BY published_at DESC,id DESC LIMIT 1")).first<{id:string;object_key:string;sha256:string}>();
 if(!release)return Response.json({error:"公開用データは確認中です。承認した版をここから配布します。",status:"awaiting_review"},{status:404,headers});
 const object=await getReleaseObject(release.id,url.searchParams.get("part")||undefined);
 return new Response(object.body,{headers:{...headers,"X-Content-SHA256":object.sha256,"Content-Type":object.contentType}});
 }catch(e){if(e instanceof HttpError)return Response.json({error:e.message},{status:e.status,headers});console.error("public export failed",e);return Response.json({error:"公開データを取得できませんでした。"},{status:503,headers});}}
