/** Reproducible local-only comparison of frozen legacy and current Polis settings. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_ANALYSIS_OPTIONS,type AnalysisOptions} from '../lib/polis-math.ts';
import {BASE_SEED,LEGACY_ANALYSIS_OPTIONS,compact,evaluate,generate,scenarios,stats,type Fixture,type Result} from './simulate-polis.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,process.env.TUNING_OUTPUT||'outputs/polis-tuning');
mkdirSync(output,{recursive:true});
const profiles:{id:string;label:string;options:AnalysisOptions}[]=[
 {id:'legacy',label:'調整前 (.2 / 各群3回答)',options:LEGACY_ANALYSIS_OPTIONS},
 {id:'silhouette_only',label:'分離度のみ .4',options:{...LEGACY_ANALYSIS_OPTIONS,minSilhouette:.4}},
 {id:'current',label:'現行 (.45 / 対象80セッション / 各群10回答 / Wilson)',options:DEFAULT_ANALYSIS_OPTIONS},
 {id:'min20_wilson',label:'分離度.45 / 対象80セッション / 各群20回答 / Wilson',options:{...DEFAULT_ANALYSIS_OPTIONS,minBridgeVotes:20}},
];
assert.equal(DEFAULT_ANALYSIS_OPTIONS.minSilhouette,.45);
assert.equal(DEFAULT_ANALYSIS_OPTIONS.minSessions,80);
assert.equal(DEFAULT_ANALYSIS_OPTIONS.minBridgeVotes,10);
assert.equal(DEFAULT_ANALYSIS_OPTIONS.minBridgeAgreement,.6);
assert.equal(DEFAULT_ANALYSIS_OPTIONS.bridgeWilsonZ,1.96);
assert.equal(DEFAULT_ANALYSIS_OPTIONS.minBridgeLowerBound,.5);
const calibrationSeeds=Array.from({length:10},(_,repeat)=>BASE_SEED+repeat*1009);
const validationSeeds=Array.from({length:5},(_,repeat)=>BASE_SEED+1_000_003+repeat*991);
assert.equal(new Set([...calibrationSeeds,...validationSeeds]).size,15);
const validationConditions=['two','three','weak','random','biased','continuous','continuous_line'];
const startupSizes=[20,40,80,160,1000];
const startupConditions=['three','weak','minority','minority2','sparse','late','random','limited_bridge_coverage'];
type Row=ReturnType<typeof compact>&{phase:'calibration'|'validation'|'startup';condition:string;participants:number;profile:string;trueBridges:number;focusBridge:null|{id:string;selected:boolean;groups:{id:number;agree:number;seen:number}[]}};
const results:Row[]=[];
function focusEvidence(fixture:Fixture,result:Result,opinionId?:string):Row['focusBridge']{
 if(!opinionId)return null;
 const assignment=new Map(result.sessionIds.map((id,i)=>[id,result.analysis.points[i].group]));
 const groups=result.analysis.groups.map(group=>({id:group.id,agree:0,seen:0}));
 for(const vote of fixture.votes){
  if(vote.opinion_id!==opinionId||vote.value===2)continue;
  const group=assignment.get(vote.session_id);if(group===undefined)continue;
  groups[group].seen++;if(vote.value===-1)groups[group].agree++;
 }
 return {id:opinionId,selected:result.bridgeIds.includes(opinionId),groups};
}
function compare(fixture:Fixture,phase:Row['phase'],condition=fixture.scenario,focusBridge?:string){
 for(const profile of profiles){
  const result=evaluate(fixture,profile.options);
  results.push({...compact(result),phase,condition,participants:fixture.sessions.length,profile:profile.id,trueBridges:fixture.trueBridges.length,focusBridge:focusEvidence(fixture,result,focusBridge)});
 }
}
for(const scenario of scenarios){
 for(const seed of calibrationSeeds)compare(generate(scenario,seed),'calibration');
 console.log(`Calibration: ${scenario.id} / 10 seeds / 4 profiles`);
}
for(const condition of validationConditions){
 for(const seed of validationSeeds)compare(generate(scenarios.find(s=>s.id===condition)!,seed),'validation');
 console.log(`Validation: ${condition} / 5 distinct seeds / 4 profiles`);
}
for(const condition of startupConditions){
 for(const count of startupSizes){
  const scenario=scenarios.find(s=>s.id===(condition==='limited_bridge_coverage'?'minority':condition))!;
  const fixture=generate(scenario,BASE_SEED,'adaptive',count);
  let focusBridge:string|undefined;
  if(condition==='limited_bridge_coverage'){
   // Restrict one planted bridge to at most three observed minority responses.
   // Preserve all observed outcomes; no favorable responses are manufactured.
   focusBridge=fixture.opinionIds[2];let retained=0;
   const small=new Set(fixture.sessions.filter(s=>s.group===1).map(s=>s.id));
   fixture.votes=fixture.votes.filter(v=>v.opinion_id!==focusBridge||!small.has(v.session_id)||retained++<3);
  }
  compare(fixture,'startup',condition,focusBridge);
 }
 console.log(`Startup: ${condition} / ${startupSizes.join(',')} participants / 4 profiles`);
}
const rows=(phase:Row['phase'],condition:string,profile:string)=>results.filter(r=>r.phase===phase&&r.condition===condition&&r.profile===profile);
const summarize=(runs:Row[])=>({runs:runs.length,ready:runs.filter(r=>r.status==='ready').length,statusCounts:runs.reduce((a,r)=>({...a,[r.status]:(a[r.status]||0)+1}),{} as Record<string,number>),kCounts:runs.reduce((a,r)=>({...a,[r.k]:(a[r.k]||0)+1}),{} as Record<string,number>),eligible:stats(runs.map(r=>r.eligible)),silhouette:stats(runs.map(r=>r.silhouette)),ari:stats(runs.map(r=>r.ari)),bridges:stats(runs.map(r=>r.bridges)),bridgePrecision:stats(runs.map(r=>r.bridgePrecision)),bridgeRecall:stats(runs.map(r=>r.bridgeRecall))});
const summary=(['calibration','validation'] as const).flatMap(phase=>(phase==='calibration'?scenarios.map(s=>s.id):validationConditions).flatMap(condition=>profiles.map(profile=>({phase,condition,profile:profile.id,...summarize(rows(phase,condition,profile.id))}))));
// Regression checks concern this generator and these seeds, not population claims.
const current=(condition:string)=>results.filter(r=>r.phase!=='startup'&&r.condition===condition&&r.profile==='current');
assert.equal(current('random').length,15);assert.ok(current('random').every(r=>r.status==='unclear'));
for(const [condition,k] of [['two',2],['three',3],['four',4],['sparse',3]] as const){
 assert.ok(current(condition).every(r=>r.status==='ready'&&r.k===k),`${condition}: retain expected groups`);
 assert.ok(current(condition).every(r=>r.bridges===8&&r.bridgePrecision===1&&r.bridgeRecall===1),`${condition}: preserve eight planted bridges`);
}
assert.equal(rows('calibration','weak','current').filter(r=>r.status==='ready').length,9);
assert.equal(rows('validation','weak','current').filter(r=>r.status==='ready').length,5);
assert.ok(current('weak').filter(r=>r.status==='ready').every(r=>r.k===3&&r.bridges===8&&r.bridgePrecision===1&&r.bridgeRecall===1));
assert.ok(current('minority2').every(r=>r.status==='unclear'&&r.k===0&&r.bridges===0),'98:2: suppress misleading split without claiming recovery');
assert.ok(current('continuous_line').every(r=>r.status==='ready'),'Known limit: continuous one-dimensional responses still split');
const startupGridPath=resolve(output,'startup-grid.json');
function loadOrGenerateStartupGrid(){
 if(existsSync(startupGridPath))return JSON.parse(readFileSync(startupGridPath,'utf8'));
 const counts=[8,20,40,60,80,100,160];
 const sourceOptions={...DEFAULT_ANALYSIS_OPTIONS,minSessions:8,minSilhouette:.4};
 const gridRows:(ReturnType<typeof compact>&{mode:string;condition:string;participants:number})[]=[];
 for(const condition of ['random','biased','three'])for(const seed of calibrationSeeds){
  const scenario=scenarios.find(s=>s.id===condition)!,complete=generate(scenario,seed);
  for(const n of counts)for(const mode of ['independent','first_n_prefix']){
   const selected=new Set(complete.sessions.slice(0,n).map(s=>s.id));
   const fixture=mode==='independent'?generate(scenario,seed,'adaptive',n):{...complete,sessions:complete.sessions.slice(0,n),votes:complete.votes.filter(v=>selected.has(v.session_id))};
   gridRows.push({...compact(evaluate(fixture,sourceOptions)),mode,condition,participants:n});
  }
 }
 const summaries=['independent','first_n_prefix'].flatMap(mode=>['random','biased','three'].flatMap(condition=>counts.map(n=>{
  const rs=gridRows.filter(r=>r.mode===mode&&r.condition===condition&&r.participants===n),silhouettes=rs.map(r=>r.silhouette).filter((x):x is number=>x!==null);
  return {mode,condition,participants:n,ready:rs.filter(r=>r.status==='ready').length,total:rs.length,meanBridges:rs.reduce((a,r)=>a+r.bridges,0)/rs.length,minEligible:Math.min(...rs.map(r=>r.eligible)),silhouetteMax:silhouettes.length?Math.max(...silhouettes):null};
 })));
 const grid={syntheticOnly:true,options:sourceOptions,settings:'minSessions8 / minSilhouette.4 / minBridgeVotes10 / Wilson z1.96 and lower bound.5',counts,summaries,rows:gridRows};
 writeFileSync(startupGridPath,JSON.stringify(grid,null,2)+'\n');return grid;
}
const startupGrid=loadOrGenerateStartupGrid();
const startupGateComparison=startupGrid?{
 source:'startup-grid.json',sourceSettings:'minSessions8, minSilhouette.4, minBridgeVotes10, Wilson z1.96 / lowerBound.5',
 method:'Apply selected eligibility floor and silhouette gate to saved fitted candidates. New gates do not change fitting or bridges for accepted results.',
 options:DEFAULT_ANALYSIS_OPTIONS,
 summaries:startupGrid.summaries.map((summary:{mode:string;condition:string;participants:number;ready:number;total:number})=>{
  const rs=startupGrid.rows.filter((r:{mode:string;condition:string;participants:number})=>r.mode===summary.mode&&r.condition===summary.condition&&r.participants===summary.participants);
  const accepted=rs.filter((r:{eligible:number;silhouette:number|null})=>r.eligible>=DEFAULT_ANALYSIS_OPTIONS.minSessions&&r.silhouette!==null&&r.silhouette>=DEFAULT_ANALYSIS_OPTIONS.minSilhouette);
  return {...summary,previousReady:summary.ready,ready:accepted.length,meanBridges:accepted.reduce((sum:number,r:{bridges:number})=>sum+r.bridges,0)/rs.length};
 }),
}:null;
const freshSeeds=Array.from({length:5},(_,repeat)=>90_000_001+repeat*1009);
assert.ok(freshSeeds.every(seed=>!calibrationSeeds.includes(seed)&&!validationSeeds.includes(seed)));
const freshStartupChecks=['random','biased','three'].flatMap(condition=>freshSeeds.map(seed=>({condition,participants:80,...compact(evaluate(generate(scenarios.find(s=>s.id===condition)!,seed,'adaptive',80)))})));
const freshStartupSummary=['random','biased','three'].map(condition=>{const rs=freshStartupChecks.filter(r=>r.condition===condition);return {condition,runs:rs.length,ready:rs.filter(r=>r.status==='ready').length,meanBridges:rs.reduce((sum,r)=>sum+r.bridges,0)/rs.length,maxSilhouette:Math.max(...rs.map(r=>r.silhouette??-1))};});
if(startupGateComparison)assert.ok(startupGateComparison.summaries.filter((s:{condition:string})=>s.condition!=='three').every((s:{ready:number})=>s.ready===0));
const baselinePath=resolve(root,'outputs/polis-baseline-2026-09-18-before-tuning/results.json');
let baselineReproduced:boolean|null=null;
if(existsSync(baselinePath)){
 const baseline=JSON.parse(readFileSync(baselinePath,'utf8'));
 for(const prior of baseline.baseline){
  const rerun=rows('calibration',prior.scenario,'legacy').find(r=>r.seed===prior.seed);assert.ok(rerun);
  for(const field of ['status','k','sizes','silhouette','ari','bridgeIds','eligible','bridges'] as const)assert.deepEqual(rerun[field],prior[field],`Frozen legacy mismatch: ${prior.scenario}/${prior.seed}/${field}`);
 }
 baselineReproduced=true;
}
const digest=(path:string)=>createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');
const limitations=[
 '人工回答の生成モデルと固定シードに対する比較。実際の住民の意見、最適な閾値、母集団の誤検出率を推定したものではない。',
 'Wilson下限は選ばれた群内の二項比率に対する根拠の強さの目安。群の推定・選択、複数意見の比較、適応的提示を補正した検定ではない。',
 'パスは共通点の分母に含み、無関係と欠損は含まない。固定した最低回答数だけで品質を保証するものではない。',
 '4設定による20〜160人の立ち上がり表は各条件1シードのみ。追加の420回と新しい5シードも同じ生成モデル内の検証であり、実データの誤検出率は保証しない。',
 '1次元の連続的な意見は分割される。98対2の少数派は復元されず表示を保留する。パスの利用傾向による分類、疎な1人による全体保留は未解決。',
 '同じシミュレーションから既に確認していた検証用5シードは探索用10シードと異なるが、今回初めて見る未使用データではない。',
];
const report={schemaVersion:1,syntheticOnly:true,createdAt:new Date().toISOString(),command:'npm run tune:polis',node:process.version,baselineReproduced,profiles,calibrationSeeds,validationSeeds,validationConditions,startupSizes,startupConditions,summary,results,startupGateComparison,freshSeeds,freshStartupChecks,freshStartupSummary,sourceHashes:{math:digest('lib/polis-math.ts'),routing:digest('lib/routing.ts'),generator:digest('scripts/simulate-polis.ts'),tuning:digest('scripts/tune-polis.ts')},limitations};
writeFileSync(resolve(output,'before-after.json'),JSON.stringify(report,null,2)+'\n');
const fmt=(n:number|null,d=2)=>n==null?'—':n.toFixed(d);
const pair=(condition:string,profile:string,field:'ready'|'bridges'|'ari')=>{const s=summary.find(s=>s.phase==='calibration'&&s.condition===condition&&s.profile===profile)!;return field==='ready'?`${s.ready}/${s.runs}`:fmt(s[field].mean);};
const startupTable=(condition:string)=>startupSizes.map(n=>`|${n}|${profiles.map(p=>{const r=rows('startup',condition,p.id).find(r=>r.participants===n)!;return `${r.status==='ready'?`${r.k}群`:'保留'} / ${r.bridges}件`;}).join('|')}|`);
const lines=[
 '# Polis パラメータ調整：ローカル人工データ比較','',
 '暫定設定：群表示の分離度を 0.2 → 0.45、分析開始を対象8 → 80セッション、共通点に必要な各群の回答を 3 → 10 に変更。さらに各群の観測賛成率 60%以上と Wilson 下限（z=1.96）が50%を超える条件を併用する。PCA・群数探索・小群の最低人数は据え置く。','',
 'すべて人工データ。公開・デプロイ・DB書き込み・通信は行っていない。実データを得たら再調整するための保守的な初期値であり、統計的な正解や最適値ではない。','',
 '## 同一回答での変更前後','',
 '1,000人、16条件×10シード×4設定。表の共通点は10シードの平均件数。群が保留された場合は0件としている。','',
 '|条件|調整前の群表示|現行の群表示|調整前の共通点|現行の共通点|現行ARI平均|','|---|---:|---:|---:|---:|---:|',
 ...scenarios.map(s=>`|${s.name}|${pair(s.id,'legacy','ready')}|${pair(s.id,'current','ready')}|${pair(s.id,'legacy','bridges')}|${pair(s.id,'current','bridges')}|${pair(s.id,'current','ari')}|`),'',
 '別の5シード×7条件でも比較した（同じ生成モデル）。ランダムは探索・検証を合わせた15回すべて保留。明瞭な2・3・4群と疎な回答の3群、8件の共通点を保持した。弱い3群は探索9/10・別シード5/5で表示（計14/15）。境界付近の1回は表示を保留した。98対2の条件は誤分類の表示を止めたが、20人の少数派の復元はできていない。1次元の連続的な回答は引き続き群に分かれる。','',
 '## 立ち上がりと少数群','',
 '各人数を独立に生成し、最初のシードで比較。各セルは「表示された群数 / 共通点数」。この少数シードの比較だけで立ち上がり時の誤検出率は判断できない。','',
 ...['three','minority','sparse','limited_bridge_coverage','random'].flatMap(id=>[
 `### ${id==='limited_bridge_coverage'?'90対10・1つの共通点の少数群回答を最大3件に制限':scenarios.find(s=>s.id===id)!.name}`,'',
 '|人数|調整前|分離度のみ.4|現行：.45・80対象・各群10回答＋Wilson|現行から各群20回答へ|','|---:|---|---|---|---|',...startupTable(id),'',
 ]),
 '共通点の最低回答数を20にすると少人数の群に十分な回答が集まるまで共通点が減る。10を暫定値とし、不確実性はWilson下限でも抑える。賛成率60%の基準は残す。小群の人数条件を大きくする変更は行わない。','',
 '## 立ち上がり時の追加確認','',
 '分離度0.4・対象8セッションからの表示では、20〜40人のランダム回答も群に分かれた。そのため8・20・40・60・80・100・160人、ランダム／意見別賛成率／明瞭な3群、10シードを追加比較。各人数を独立に生成する条件と、同じ1,000人の回答列を先頭N人に切る条件を比較した（420回）。原結果は startup-grid.json に固定保存。','',
 'その候補結果に80対象セッション・分離度0.45を適用すると、ランダム／意見別賛成率の群表示はともに全条件で0回、明瞭な3群は80・100・160人で各10/10（両生成方式）となった。これは同じ探索結果による判断であり、一般的な誤検出率の保証ではない。80未満の明瞭な群の表示も待つ運用上の選択である。','',
 'さらにこれまで使っていない5シード（90,000,001 + 1,009×反復番号）を各80人で確認した。これは同じ生成モデル内の小さな追加確認である。','',
 '|新しいシードでの条件|表示回数|共通点の平均|最大分離度|','|---|---:|---:|---:|',
 ...freshStartupSummary.map(s=>`|${s.condition}|${s.ready}/${s.runs}|${fmt(s.meanBridges)}|${fmt(s.maxSilhouette,3)}|`),'',
 '## 再実行と保存','',
 '- `npm run tune:polis`：現行実装で4設定を比較し、before-after.json と本レポートを生成する。','- `npm run simulate:polis:edges`：旧設定の3つの問題例と現行設定での結果を比較する。3人群は残り、その群の2/3賛成は共通点から除外される。','- `npm run simulate:polis`：旧設定を固定した従来ベンチマーク。現在のアプリ既定値の検証は tune:polis を使う。',
 `- 調整前の記録は outputs/polis-baseline-2026-09-18-before-tuning/ に保存。旧設定の主要出力との完全一致：${baselineReproduced===true?'確認済み': '比較用ファイルなし'}。`,'',
 '## 解釈上の限界','',...limitations.map(s=>`- ${s}`),'',
];
writeFileSync(resolve(output,'REPORT.md'),lines.join('\n'));
console.log(`PASS: ${results.length} main + ${freshStartupChecks.length} fresh startup analysis runs; frozen baseline reproduced=${baselineReproduced}; ${output}`);
