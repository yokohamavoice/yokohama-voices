import { env } from "cloudflare:workers";
import { CREATOR_NAME } from "@/lib/public-data";
import { HttpError } from "@/lib/server";
/** Display identity is separate from the private account that runs management. */
export function validateModerationIdentity(actor:unknown,runUrl:unknown,action:unknown,requestUrl:string){
 if(actor!==CREATOR_NAME||typeof runUrl!=="string")throw new HttpError(400,"担当者と実行記録を確認してください。");
 if(action==="initialize_counts"&&runUrl==="local:maintenance"){
  if(!["localhost","127.0.0.1","[::1]"].includes(new URL(requestUrl).hostname))throw new HttpError(400,"この初期化操作はローカルで実行してください。");
  return;
 }
 const repository=env.MODERATION_REPOSITORY;
 if(!repository||!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository))throw new HttpError(503,"プロジェクト専用の運営用GitHubを設定してください。");
 const prefix=`https://github.com/${repository}/actions/runs/`;
 if(!runUrl.startsWith(prefix)||!/^\d+$/.test(runUrl.slice(prefix.length)))throw new HttpError(400,"運営用GitHubの実行記録を確認してください。");
}
