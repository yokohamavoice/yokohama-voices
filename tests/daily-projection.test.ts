import assert from "node:assert/strict";
import { AnalysisAccumulator, analyzeAccumulated, projectParticipant, type AnalysisWarmStart, type Vote } from "../lib/polis-math.ts";
const ids=Array.from({length:24},(_,i)=>`p${i}`);
function fixture(count=160):Vote[]{
  let state=0x12345678;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/2**32;};
  const votes:Vote[]=[];
  for(let i=0;i<count;i++)for(let j=0;j<ids.length;j++){
    const draw=random();
    if(j>=8&&draw<.15)continue;
    const value=j===0?-1:j>=20&&draw<.35?0:(i%2?1:-1)*(j%2?1:-1)*(draw>.88?-1:1);
    votes.push({session_id:`s${String(i).padStart(4,"0")}`,opinion_id:ids[j],value});
  }
  return votes;
}
const votes=fixture(),acc=new AnalysisAccumulator(ids).add(votes),daily=analyzeAccumulated(acc);
assert.equal(daily.analysis.status,"ready");assert.ok(daily.model);
const model=daily.model!;
const bySession=new Map<string,Record<string,number>>();
for(const vote of votes){let answers=bySession.get(vote.session_id);if(!answers){answers={};bySession.set(vote.session_id,answers);}answers[vote.opinion_id]=vote.value;}
for(let i=0;i<daily.sessionIds.length;i++){
  const projected=projectParticipant(model,bySession.get(daily.sessionIds[i])!);assert.ok(projected);
  assert.ok(Math.abs(projected.x-daily.analysis.points[i].x)<1e-10);
  assert.ok(Math.abs(projected.y-daily.analysis.points[i].y)<1e-10);
  assert.equal(projected.group,daily.analysis.points[i].group);assert.equal(projected.mine,true);
}
const own=bySession.get(daily.sessionIds[0])!;
assert.deepEqual(projectParticipant(model,{...own,unseen_opinion:1,unrelated_opinion:2}),projectParticipant(model,own));
const six=Object.fromEntries(ids.slice(0,6).map(id=>[id,1]));
assert.ok(projectParticipant(model,six));
assert.equal(projectParticipant(model,{...six,p0:0,new_opinion:1}),null);
assert.equal(projectParticipant(model,{...six,p0:2,new_opinion:1}),null);
assert.equal(projectParticipant(model,{...six,p0:undefined as unknown as number}),null);
const withPass={...six,p6:0,p7:2};
const projected=projectParticipant(model,withPass)!;
const expected=(axis:number)=>ids.reduce((sum,id,j)=>{
  const value=withPass[id as keyof typeof withPass];
  return sum+(value===-1||value===0||value===1?(value-model.means[j])*model.components[axis][j]:0);
},0)*Math.sqrt(ids.length/7);
assert.ok(Math.abs(projected.x-expected(0))<1e-10);assert.ok(Math.abs(projected.y-expected(1))<1e-10);
assert.equal(projectParticipant({...model,centers:[]},own),null);
assert.equal(projectParticipant({...model,components:[[],[]]},own),null);
const before=JSON.stringify(model);projectParticipant(model,own);assert.equal(JSON.stringify(model),before);
const previous:AnalysisWarmStart={model,sessionIds:daily.sessionIds,groups:daily.analysis.points.map(point=>point.group)};
const warm=analyzeAccumulated(acc,{},previous);
assert.ok(warm.diagnostics.pcaWarmStarted.every(Boolean));
assert.ok(warm.diagnostics.pcaIterations.reduce((a,b)=>a+b)<daily.diagnostics.pcaIterations.reduce((a,b)=>a+b));
assert.ok(Math.abs(warm.analysis.explained!-daily.analysis.explained!)<1e-7);
assert.ok(Math.abs(warm.analysis.silhouette!-daily.analysis.silhouette!)<1e-6);
assert.equal(warm.analysis.groups.length,daily.analysis.groups.length);
assert.equal(warm.diagnostics.candidates.length,daily.diagnostics.candidates.length);
assert.equal(warm.diagnostics.candidates.filter(candidate=>candidate.warmStart).length,1);
assert.ok(warm.diagnostics.candidates.filter(candidate=>candidate.groupCount===daily.analysis.groups.length&&!candidate.warmStart).length>=1);
const shifted:AnalysisWarmStart={...previous,model:{...model,centers:model.centers.map(center=>({...center,x:center.x*1e6+1e9,y:center.y*1e6-1e9}))}};
const recentered=analyzeAccumulated(acc,{},shifted);
assert.deepEqual(recentered.analysis,warm.analysis);
assert.deepEqual(recentered.diagnostics,warm.diagnostics);
const expandedVotes=fixture(180),expandedAcc=new AnalysisAccumulator(ids).add(expandedVotes);
const expandedCold=analyzeAccumulated(expandedAcc),expandedWarm=analyzeAccumulated(expandedAcc,{},previous);
assert.equal(expandedWarm.analysis.status,"ready");
assert.ok(Math.abs(expandedWarm.analysis.explained!-expandedCold.analysis.explained!)<1e-6);
assert.ok(expandedWarm.analysis.silhouette!>=expandedCold.analysis.silhouette!-.002);
assert.equal(expandedWarm.analysis.groups.length,expandedCold.analysis.groups.length);
const reversed=analyzeAccumulated(new AnalysisAccumulator([...ids].reverse()).add(votes),{},previous);
assert.ok(reversed.diagnostics.pcaWarmStarted.every(Boolean));
assert.ok(Math.abs(reversed.analysis.explained!-daily.analysis.explained!)<1e-7);
const renamedIds=ids.map(id=>`new-${id}`),renamedVotes=votes.map(vote=>({...vote,opinion_id:`new-${vote.opinion_id}`}));
const incompatible=analyzeAccumulated(new AnalysisAccumulator(renamedIds).add(renamedVotes),{},previous);
assert.ok(incompatible.diagnostics.pcaWarmStarted.every(value=>!value));
assert.equal(incompatible.analysis.status,"ready");
const noOverlap=analyzeAccumulated(acc,{}, {...previous,sessionIds:previous.sessionIds.map(id=>`old-${id}`)});
assert.ok(noOverlap.diagnostics.candidates.every(candidate=>!candidate.warmStart));
const unclear=analyzeAccumulated(acc,{minSilhouette:1},previous);
assert.equal(unclear.analysis.status,"unclear");assert.ok(unclear.model);assert.deepEqual(unclear.model.centers,[]);
assert.equal(projectParticipant(unclear.model,own),null);
console.log("PASS: fixed-model projection matches daily points; sparse/pass/missing/new/unrelated handling; warm PCA convergence and cluster quality; current-coordinate membership re-centering; feature and membership fallback.");
console.log(JSON.stringify({cold:daily.diagnostics.pcaIterations,warm:warm.diagnostics.pcaIterations,expandedCold:expandedCold.diagnostics.pcaIterations,expandedWarm:expandedWarm.diagnostics.pcaIterations}));
// Swap the two leading directions. A perfectly reused old eigenvector would
// otherwise remain a fixed point even though it is no longer the first PC.
const swapIds=Array.from({length:12},(_,i)=>`swap${i}`);
const swapVotes=(after:boolean):Vote[]=>Array.from({length:160},(_,i)=>swapIds.map((id,j)=>({
  session_id:`swap-session-${i}`,opinion_id:id,
  value:j<6?(!after||i%8<4?(i%2?1:-1):0):(after||i%8<4?(Math.floor(i/2)%2?1:-1):0),
}))).flat();
const beforeSwap=analyzeAccumulated(new AnalysisAccumulator(swapIds).add(swapVotes(false)));
assert.ok(beforeSwap.model);
const swapAcc=new AnalysisAccumulator(swapIds).add(swapVotes(true));
const swappedCold=analyzeAccumulated(swapAcc);
const swappedWarm=analyzeAccumulated(swapAcc,{}, {model:beforeSwap.model,sessionIds:beforeSwap.sessionIds,groups:beforeSwap.analysis.points.map(point=>point.group)});
assert.ok(swappedCold.model&&swappedWarm.model);
const alignment=swappedCold.model.components[0].reduce((sum,value,i)=>sum+value*swappedWarm.model!.components[0][i],0);
assert.ok(Math.abs(alignment)>1-1e-8);
console.log("PASS: changed dominant PCA direction is discovered from the previous solution.");
