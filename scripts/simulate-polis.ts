/** Local synthetic benchmark. No network, credentials, real votes or DB writes. */
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {AnalysisAccumulator,analyzeAccumulated,type AnalysisOptions,type Vote} from '../lib/polis-math.ts';
import {distribution,draw,type RoutingCandidate} from '../lib/routing.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const seedData=JSON.parse(readFileSync(resolve(root,'data/seed.json'),'utf8'));
const opinions=seedData.opinions as {id:string;tagId:string;text:string}[];
const ids=opinions.map(o=>o.id);
export const N=1000;
export const BASE_SEED=20260918;
const output=resolve(root,process.env.SIMULATION_OUTPUT||'outputs/polis-simulation');
const repetitions=Number(process.env.SIMULATION_REPEATS||10);

export type Scenario={id:string;name:string;groups?:number;weights?:number[];answers:number;strength?:number;kind?:'random'|'biased'|'continuous'|'continuous_line'|'uniform'|'disconnected';pass?:number;unrelated?:number;heterogeneous?:boolean;lateOpinion?:boolean};
export const scenarios:Scenario[]=[
 {id:'two',name:'明瞭な2群',groups:2,answers:20,strength:3.8},
 {id:'three',name:'明瞭な3群',groups:3,answers:20,strength:3.8},
 {id:'four',name:'明瞭な4群',groups:4,answers:20,strength:3.8},
 {id:'weak',name:'弱い3群',groups:3,answers:20,strength:1.5},
 {id:'minority',name:'90対10の2群',groups:2,weights:[.9,.1],answers:20,strength:3.8},
 {id:'minority2',name:'98対2の2群',groups:2,weights:[.98,.02],answers:20,strength:3.8},
 {id:'sparse',name:'3群・1人8回答',groups:3,answers:8,strength:3.8},
 {id:'heterogeneous',name:'3群・回答数6〜40',groups:3,answers:20,strength:3.8,heterogeneous:true},
 {id:'many_pass',name:'3群・パス35%',groups:3,answers:20,strength:3.8,pass:.35},
 {id:'random',name:'集団差なし・賛否ランダム',kind:'random',answers:20},
 {id:'biased',name:'集団差なし・意見別の賛成率あり',kind:'biased',answers:20},
 {id:'continuous',name:'連続的な意見・離散群なし',kind:'continuous',answers:20},
 {id:'continuous_line',name:'1次元で連続的な意見・離散群なし',kind:'continuous_line',answers:20},
 {id:'uniform',name:'全員が同じ賛成回答',kind:'uniform',answers:20,pass:0,unrelated:0},
 {id:'disconnected',name:'回答項目が重ならない2集団',kind:'disconnected',groups:2,answers:12,strength:3.8},
 {id:'late',name:'3群・新規意見に少数回答',groups:3,answers:20,strength:3.8,lateOpinion:true},
];
function rng(seed:number){let state=seed>>>0;return ()=>{state+=0x6D2B79F5;let v=state;v=Math.imul(v^(v>>>15),v|1);v^=v+Math.imul(v^(v>>>7),v|61);return ((v^(v>>>14))>>>0)/4294967296;};}
function normal(random:()=>number){return Math.sqrt(-2*Math.log(Math.max(random(),1e-12)))*Math.cos(2*Math.PI*random());}
function shuffle<T>(values:T[],random:()=>number){for(let i=values.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[values[i],values[j]]=[values[j],values[i]];}return values;}
const sigmoid=(v:number)=>1/(1+Math.exp(-v));
const shared=(j:number)=>j%5===2;
const conditionalP=(scenario:Scenario,j:number,x:number,y:number)=>{
 if(scenario.kind==='uniform')return 1;
 if(scenario.kind==='random')return .5;
 if(scenario.kind==='biased')return shared(j)?.85:.2+.15*(j%5);
 if(scenario.lateOpinion&&j===39)return .55;
 if(shared(j))return .90;
 const angle=j*2.399963229728653;
 return sigmoid(Math.cos(angle)*x+Math.sin(angle)*y);
};
export function generate(scenario:Scenario,seed:number,routing:'adaptive'|'uniform'='adaptive',participants=N){
 const N=participants;assert.ok(Number.isInteger(N)&&N>0);
 const random=rng(seed),responseRandom=rng(seed^0xabc34791);
 const k=scenario.groups||1,weights=scenario.weights||Array(k).fill(1/k);
 const labels:number[]=[];
 for(let g=0;g<k;g++){const until=g===k-1?N:Math.round(N*weights.slice(0,g+1).reduce((a,b)=>a+b,0));while(labels.length<until)labels.push(g);}
 shuffle(labels,random);
 const latent=labels.map(g=>scenario.kind==='continuous'?[normal(random)*1.5,normal(random)*1.5]:scenario.kind==='continuous_line'?[normal(random)*3.8,normal(random)*.1]:[(scenario.strength||0)*Math.cos(g*2*Math.PI/k)+normal(random)*.25,(scenario.strength||0)*Math.sin(g*2*Math.PI/k)+normal(random)*.25]);
 // Potential responses are drawn before routing: uniform/adaptive see identical people.
 const pass=scenario.pass??.08,unrelated=scenario.unrelated??.02;
 const potential=latent.map(([x,y])=>ids.map((_,j)=>{const v=responseRandom();return v<unrelated?2:v<unrelated+pass?0:responseRandom()<conditionalP(scenario,j,x,y)?-1:1;}));
 const candidates:RoutingCandidate[]=opinions.map(o=>({...o,agree:0,disagree:0,pass:0,unrelated:0}));
 const votes:Vote[]=[],sessions:{id:string;group:number;answers:number}[]=[];
 let minimumProbability=1;
 for(let i=0;i<N;i++){
  const session_id=`sim-${String(i).padStart(4,'0')}`,issued:Record<string,number>={};
  let pool=candidates.filter((_,j)=>scenario.kind!=='disconnected'||(labels[i]===0?j<20:j>=20));
  if(scenario.lateOpinion&&i<N-18)pool=pool.filter(c=>c.id!==ids[39]);
  const count=scenario.heterogeneous?6+(i%35):scenario.answers;
  for(let a=0;a<Math.min(count,ids.length);a++){
   if(!pool.length)break;
   const probabilities=routing==='adaptive'?distribution(pool,issued):pool.map(c=>({id:c.id,probability:1/pool.length}));
   assert.ok(Math.abs(probabilities.reduce((s,p)=>s+p.probability,0)-1)<1e-10);
   const chosen=draw(probabilities,random())!;minimumProbability=Math.min(minimumProbability,chosen.probability);
   const candidate=pool.find(c=>c.id===chosen.id)!,j=ids.indexOf(chosen.id),value=potential[i][j];
   votes.push({session_id,opinion_id:chosen.id,value});
   issued[candidate.tagId]=(issued[candidate.tagId]||0)+1;
   candidate[value===-1?'agree':value===1?'disagree':value===0?'pass':'unrelated']++;
   pool=pool.filter(c=>c.id!==chosen.id);
  }
  sessions.push({id:session_id,group:labels[i],answers:count});
 }
 const trueBridges=ids.filter((_,j)=>{
  if(!scenario.groups)return false;
  for(let g=0;g<k;g++){
   let sum=0,count=0;
   for(let i=0;i<N;i++)if(labels[i]===g){sum+=conditionalP(scenario,j,latent[i][0],latent[i][1]);count++;}
   if((1-pass-unrelated)/(1-unrelated)*sum/count<.6)return false;
  }
  return true;
 });
 assert.equal(new Set(votes.map(v=>`${v.session_id}:${v.opinion_id}`)).size,votes.length);
 assert.equal(sessions.length,N);
 return {synthetic:true,notice:'人工データ。横浜市民の意見・世論の予測ではありません。',scenario:scenario.id,seed,routing,opinionIds:ids,opinions,votes,sessions,trueBridges,minimumProbability};
}
export type Fixture=ReturnType<typeof generate>;
export function ari(a:number[],b:number[]){
 if(a.length!==b.length||a.length<2)return null;
 const rows=new Map<number,number>(),cols=new Map<number,number>(),cells=new Map<string,number>();
 for(let i=0;i<a.length;i++){rows.set(a[i],(rows.get(a[i])||0)+1);cols.set(b[i],(cols.get(b[i])||0)+1);const key=`${a[i]},${b[i]}`;cells.set(key,(cells.get(key)||0)+1);}
 const choose=(n:number)=>n*(n-1)/2,sum=(m:Map<unknown,number>)=>[...m.values()].reduce((s,n)=>s+choose(n),0);
 const r=sum(rows),c=sum(cols),expected=r*c/choose(a.length),denom=(r+c)/2-expected;
 return Math.abs(denom)<1e-12?1:(sum(cells)-expected)/denom;
}
export function evaluate(fixture:Fixture,overrides:Partial<AnalysisOptions>={}){
 const start=performance.now();
 const {analysis,sessionIds,diagnostics}=analyzeAccumulated(new AnalysisAccumulator(ids).add(fixture.votes),overrides);
 const elapsedMs=performance.now()-start;
 const known=new Map(fixture.sessions.map(s=>[s.id,s.group]));
 const structured=!!scenarios.find(s=>s.id===fixture.scenario)?.groups;
 const correct=analysis.bridges.filter(b=>fixture.trueBridges.includes(b.id)).length;
 const groupRecovery=structured?[...new Set(fixture.sessions.map(s=>s.group))].map(truth=>{
  const eligible= sessionIds.filter(id=>known.get(id)===truth).length;
  const planted=fixture.sessions.filter(s=>s.group===truth).length;
  const matches=analysis.groups.map(g=>{const overlap=sessionIds.filter((id,i)=>known.get(id)===truth&&analysis.points[i].group===g.id).length;return {group:g.id,overlap,precision:overlap/g.size,recall:eligible?overlap/eligible:0,jaccard:overlap/(eligible+g.size-overlap)};}).sort((a,b)=>b.jaccard-a.jaccard);
  return {truth,planted,eligible,best:matches[0]||null};
 }):[];
 return {scenario:fixture.scenario,seed:fixture.seed,overrides,votes:fixture.votes.length,eligible:analysis.eligible,status:analysis.status,k:analysis.groups.length,sizes:analysis.groups.map(g=>g.size),silhouette:diagnostics.bestSilhouette,explained:diagnostics.explained,ari:structured&&sessionIds.length?ari(sessionIds.map(id=>known.get(id)!),analysis.points.map(p=>p.group)):null,groupRecovery,bridges:analysis.bridges.length,bridgePrecision:structured&&analysis.bridges.length?correct/analysis.bridges.length:null,bridgeRecall:structured&&fixture.trueBridges.length?correct/fixture.trueBridges.length:null,bridgeIds:analysis.bridges.map(b=>b.id),elapsedMs,analysis,sessionIds,diagnostics};
}
export type Result=ReturnType<typeof evaluate>;
export const compact=(result:Result)=>{const {analysis,sessionIds,diagnostics,...rest}=result;void analysis;void sessionIds;return {...rest,retainedOpinions:diagnostics.retainedOpinions};};
const mean=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
export const stats=(xs:(number|null)[])=>{const values=xs.filter((x):x is number=>x!==null);return {mean:mean(values),min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null};};
/** Frozen pre-tuning behavior for reproducible comparisons, never app defaults. */
export const LEGACY_ANALYSIS_OPTIONS:AnalysisOptions=Object.freeze({
 minSubstantiveVotes:6,minSessions:8,minOpinionVotes:3,minRetainedOpinions:6,
 pcaIterations:100,kMeansIterations:60,minGroupSize:3,maxGroups:4,starts:4,
 minSilhouette:.2,silhouetteTargetsPerGroup:256,silhouetteReferencesPerGroup:128,
 minBridgeVotes:3,minBridgeAgreement:.6,bridgeWilsonZ:0,minBridgeLowerBound:0,
});
const evaluateLegacy=(fixture:Fixture,overrides:Partial<AnalysisOptions>={})=>evaluate(fixture,{...LEGACY_ANALYSIS_OPTIONS,...overrides});

function runLegacyBenchmark(){
 const evaluate=evaluateLegacy;
 assert.ok(Number.isInteger(repetitions)&&repetitions>=2&&repetitions<=100);
 mkdirSync(output,{recursive:true});
 assert.equal(ari([0,0,1,1],[1,1,0,0]),1);
 assert.ok(Math.abs(ari([0,0,1,1],[0,1,0,1])!+.5)<1e-12);
const baseline:Result[]=[],firstFixtures=new Map<string,Fixture>();
for(const scenario of scenarios){
 for(let repeat=0;repeat<repetitions;repeat++){
  const fixture=generate(scenario,BASE_SEED+repeat*1009);
  if(repeat===0){firstFixtures.set(scenario.id,fixture);if(['three','random','minority','continuous'].includes(scenario.id))writeFileSync(resolve(output,`fixture-${scenario.id}.json`),JSON.stringify(fixture));}
  baseline.push(evaluate(fixture));
 }
 const runs=baseline.filter(r=>r.scenario===scenario.id);
 console.log(`${scenario.id}: ${runs.filter(r=>r.status==='ready').length}/${runs.length} ready, k=${runs.map(r=>r.k).join(',')}, mean ARI=${stats(runs.map(r=>r.ari)).mean?.toFixed(3)}, silhouette=${stats(runs.map(r=>r.silhouette)).mean?.toFixed(3)}`);
}
const sensitivity:ReturnType<typeof compact>[]=[];
const sweeps:{parameter:keyof AnalysisOptions;values:number[];scenarios:string[]}[]=[
 {parameter:'minSubstantiveVotes',values:[4,6,8,10,15],scenarios:['three','sparse','heterogeneous','many_pass']},
 {parameter:'minGroupSize',values:[3,10,25,50],scenarios:['three','minority','minority2','random']},
 {parameter:'maxGroups',values:[2,3,4,6],scenarios:['three','four','random','continuous']},
 {parameter:'starts',values:[1,4,12],scenarios:['three','weak','minority']},
 {parameter:'pcaIterations',values:[25,100,250],scenarios:['three','weak','random']},
 {parameter:'silhouetteReferencesPerGroup',values:[64,128,256,1000],scenarios:['three','weak','random']},
];
for(const sweep of sweeps){
 for(const scenario of sweep.scenarios)for(const value of sweep.values){const r=evaluate(firstFixtures.get(scenario)!,{[sweep.parameter]:value});sensitivity.push(compact(r));}
 console.log(`Sensitivity: ${sweep.parameter} done`);
}
const samplingComparisons=['three','weak','random'].map(id=>{
 const r=evaluate(firstFixtures.get(id)!,{silhouetteReferencesPerGroup:1000,silhouetteTargetsPerGroup:1000});
 const base=baseline.find(b=>b.scenario===id)!;
 return {scenario:id,approximate:compact(base),exact:compact(r),labelARI:ari(base.analysis.points.map(p=>p.group),r.analysis.points.map(p=>p.group))};
});
const routingComparisons=['three','sparse','many_pass'].map(id=>{
 const scenario=scenarios.find(s=>s.id===id)!,adaptive=firstFixtures.get(id)!,uniform=generate(scenario,BASE_SEED,'uniform');
 const exposure=(fixture:Fixture)=>{const counts=ids.map(id=>fixture.votes.filter(v=>v.opinion_id===id).length);return {min:Math.min(...counts),max:Math.max(...counts),mean:mean(counts),commonMean:mean(counts.filter((_,j)=>shared(j)))};};
 return {scenario:id,adaptive:{...compact(baseline.find(b=>b.scenario===id)!),exposure:exposure(adaptive)},uniform:{...compact(evaluate(uniform)),exposure:exposure(uniform)}};
});
// Reapply display gate to identical fitted candidates; the threshold does not affect fitting.
const thresholds=[.2,.3,.35,.4,.45,.5,.55,.6];
const thresholdSweep=thresholds.map(threshold=>({threshold,scenarios:scenarios.map(s=>{const rs=baseline.filter(r=>r.scenario===s.id);return {scenario:s.id,accepted:rs.filter(r=>r.silhouette!==null&&r.silhouette>=threshold).length,total:rs.length};})}));
// Generalization check on independent PRNG seeds; candidate thresholds were pre-specified.
const validation:ReturnType<typeof compact>[]=[];
for(const id of ['two','three','weak','random','biased','continuous','continuous_line'])for(let repeat=0;repeat<5;repeat++)validation.push(compact(evaluate(generate(scenarios.find(s=>s.id===id)!,BASE_SEED+1_000_003+repeat*991))));
const bridgeSweep=[];
for(const scenario of ['three','sparse','late']){
 const fixture=firstFixtures.get(scenario)!,base=baseline.find(r=>r.scenario===scenario)!;
 const assignment=new Map(base.sessionIds.map((id,i)=>[id,base.analysis.points[i].group]));
 const counts=ids.map(id=>({id,groups:base.analysis.groups.map(g=>({id:g.id,agree:0,seen:0}))}));
 for(const v of fixture.votes){const g=assignment.get(v.session_id);if(g===undefined||v.value===2)continue;const cell=counts[ids.indexOf(v.opinion_id)].groups[g];cell.seen++;if(v.value===-1)cell.agree++;}
 for(const minimum of [3,10,20,30])for(const rate of [.6,.65,.7]){
  const kept=counts.filter(c=>c.groups.length&&c.groups.every(g=>g.seen>=minimum&&g.agree/g.seen>=rate));
  const correct=kept.filter(c=>fixture.trueBridges.includes(c.id)).length;
  bridgeSweep.push({scenario,minBridgeVotes:minimum,minBridgeAgreement:rate,count:kept.length,precision:kept.length?correct/kept.length:null,recall:fixture.trueBridges.length?correct/fixture.trueBridges.length:null,ids:kept.map(c=>c.id)});
 }
}
const first=firstFixtures.get('three')!,base=baseline.find(r=>r.scenario==='three')!;
const again=evaluate(first),reversed=evaluate({...first,votes:[...first.votes].reverse()});
assert.deepEqual(again.analysis,base.analysis);assert.deepEqual(reversed.analysis,base.analysis);
assert.deepEqual(generate(scenarios[1],BASE_SEED),first);
const perturbed={...first,votes:first.votes.filter((_,i)=>i%10!==0)};
const perturbResult=evaluate(perturbed),perturbMap=new Map(perturbResult.sessionIds.map((id,i)=>[id,perturbResult.analysis.points[i].group]));
const common=base.sessionIds.filter(id=>perturbMap.has(id));
const baseMap=new Map(base.sessionIds.map((id,i)=>[id,base.analysis.points[i].group]));
const robustness={deterministic:true,orderInvariant:true,removeTenPercent:{...compact(perturbResult),commonSessions:common.length,labelARI:ari(common.map(id=>baseMap.get(id)!),common.map(id=>perturbMap.get(id)!))}};
const summary=scenarios.map(s=>{const rs=baseline.filter(r=>r.scenario===s.id);return {...s,runs:rs.length,ready:rs.filter(r=>r.status==='ready').length,kCounts:rs.reduce((a,r)=>({...a,[r.k]:(a[r.k]||0)+1}),{} as Record<number,number>),eligible:stats(rs.map(r=>r.eligible)),silhouette:stats(rs.map(r=>r.silhouette)),explained:stats(rs.map(r=>r.explained)),ari:stats(rs.map(r=>r.ari)),bridgePrecision:stats(rs.map(r=>r.bridgePrecision)),bridgeRecall:stats(rs.map(r=>r.bridgeRecall)),elapsedMs:stats(rs.map(r=>r.elapsedMs))};});
const digest=(name:string)=>createHash('sha256').update(readFileSync(resolve(root,name))).digest('hex');
const report={synthetic:true,createdAt:new Date().toISOString(),participantsPerRun:N,opinions:ids.length,repetitions,baseSeed:BASE_SEED,defaults:LEGACY_ANALYSIS_OPTIONS,profile:"frozen-legacy-before-tuning",sourceHashes:{math:digest('lib/polis-math.ts'),routing:digest('lib/routing.ts'),generator:digest('scripts/simulate-polis.ts')},node:process.version,summary,baseline:baseline.map(compact),sensitivity,thresholdSweep,validation,bridgeSweep,samplingComparisons,routingComparisons,robustness,examples:baseline.filter(r=>r.seed===BASE_SEED).map(r=>({scenario:r.scenario,analysis:r.analysis,sessionIds:r.sessionIds,truth:firstFixtures.get(r.scenario)!.sessions,trueBridges:firstFixtures.get(r.scenario)!.trueBridges})),limitations:['Artificial response probabilities and latent groups; no inference about real citizens.','Known group labels evaluate this generator, not a universal optimum.','Simulation calls the actual router and math, but does not simulate HTTP concurrency or response time.','Local Node timings do not establish Cloudflare CPU or memory limits.','Most sensitivity variants use one fixed seed; threshold tests use repeated seeds and five independent validation seeds.','Bridge truth uses >=60% expected agreement among non-unrelated responses in every planted group; evaluations with higher cutoffs use that same target.','No authorization or deployments are performed.']};
writeFileSync(resolve(output,'results.json'),JSON.stringify(report,null,2));
const number=(n:number|null|undefined,d=3)=>n==null?'—':n.toFixed(d);
const lines=['# Polis機能：1,000人の人工回答によるローカル検証','','すべて人工データ。実際の横浜市民の意見・世論は表していません。',`各条件 ${N} 人 × ${ids.length} 意見、基本条件ごとに ${repetitions} 乱数シード。seed=${BASE_SEED}。回答の提示には実装中の tag-mixture-v2 を使用。`,'','## 調整前の固定設定による結果','','ARI: 仕込んだ群との一致度（1=完全一致、0≈偶然）。離散群を仕込まない条件では算出しません。','','|条件|表示された回数|群数（回数）|対象人数平均|silhouette 平均|ARI 平均|共通点precision / recall|計算ms平均|','|---|---:|---|---:|---:|---:|---|---:|',...summary.map(s=>`|${s.name}|${s.ready}/${s.runs}|${Object.entries(s.kCounts).map(([k,n])=>`${k} (${n})`).join(', ')}|${number(s.eligible.mean,0)}|${number(s.silhouette.mean)}|${number(s.ari.mean)}|${number(s.bridgePrecision.mean)} / ${number(s.bridgeRecall.mean)}|${number(s.elapsedMs.mean,0)}|`),'','## 表示の閾値（同じ推定結果で比較）','','|閾値|2群|3群|弱い3群|ランダム|意見別賛成率|連続的な意見|','|---:|---|---|---|---|---|---|',...thresholdSweep.map(t=>`|${t.threshold}|${['two','three','weak','random','biased','continuous'].map(id=>{const r=t.scenarios.find(x=>x.scenario===id)!;return `${r.accepted}/${r.total}`;}).join('|')}|`),'','## 再実行','','`npm run simulate:polis`','','このコマンドは比較用の調整前設定を固定して再現します。現行設定との比較は `npm run tune:polis` を使います。','出力: results.json（全結果と設定・実装SHA-256）、fixture-three.json（1000人の模擬回答）、同条件の図とローカルレポート。','SIMULATION_REPEATS で反復数、SIMULATION_OUTPUT で出力先を指定できます。','','## 範囲と限界','',...report.limitations.map(s=>`- ${s}`),''];
writeFileSync(resolve(output,'REPORT.md'),lines.join('\n'));
console.log(`Saved synthetic fixtures and results: ${output}`);

}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runLegacyBenchmark();
