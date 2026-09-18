import { database } from "@/db/raw";
export const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
export const validId=(id:unknown):id is string=>typeof id==="string"&&/^[a-f0-9-]{36}$/.test(id);
export async function digest(value:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join("");}
export async function getSession(req:Request){const t=req.headers.get("x-session-token");if(!t||!/^[a-f0-9]{64}$/.test(t))return null;return database().prepare("SELECT id,phase,notice_version FROM sessions WHERE token_hash=?").bind(await digest(t)).first<{id:string;phase:string;notice_version:string|null}>();}
export class HttpError extends Error {constructor(public status:number,message:string){super(message);}}
export async function bodyOf(req:Request,limit=6000){if(Number(req.headers.get("content-length")||0)>limit)throw new HttpError(413,"送信内容が長すぎます。");const raw=await req.text();if(raw.length>limit)throw new HttpError(413,"送信内容が長すぎます。");let b;try{b=JSON.parse(raw);}catch{throw new HttpError(400,"入力を確認してください。");}if(!b||typeof b!=="object"||Array.isArray(b))throw new HttpError(400,"入力を確認してください。");return b;}
export const opinionQuery=`SELECT o.id,o.tag_id AS tagId,o.text,o.kind,o.source_ids AS sourceIds,o.status,o.revision,
o.agree_count agree,o.disagree_count disagree,o.pass_count pass,
o.agree_count+o.disagree_count+o.pass_count seen,o.unrelated_count unrelated FROM opinions o`;
