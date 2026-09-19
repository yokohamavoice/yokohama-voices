import assert from "node:assert/strict";
import {
  analyze as productionAnalyze, analyzeAccumulated as productionAccumulated, AnalysisAccumulator, DEFAULT_ANALYSIS_OPTIONS,
  type AnalysisOptions, type Vote,
} from "../lib/polis-math.ts";

// Small deterministic fixtures isolate each option from the production startup gate.
const analyze=(votes:Vote[],ids:string[],mine?:string,options:Partial<AnalysisOptions>={})=>productionAnalyze(votes,ids,mine,{minSessions:8,...options});
const analyzeAccumulated=(acc:AnalysisAccumulator,options:Partial<AnalysisOptions>={})=>productionAccumulated(acc,{minSessions:8,...options});

const ids=Array.from({length:12},(_,i)=>`p${i}`);
const votes:Vote[]=[];
for(let s=0;s<12;s++)for(let p=0;p<12;p++)votes.push({
  session_id:`s${s.toString().padStart(2,"0")}`,opinion_id:ids[p],
  value:p===0?-1:(s<6?(p%2?-1:1):(p%2?1:-1)),
});
const acc=new AnalysisAccumulator(ids).add(votes);
const defaults=analyze(votes,ids,"s00");
assert.equal(productionAnalyze(votes,ids).status,"collecting");
assert.equal(productionAnalyze(votes,ids).minimum,80);
assert.deepEqual(analyze(votes,ids,"s00",{...DEFAULT_ANALYSIS_OPTIONS,minSessions:8}),defaults);
assert.deepEqual(analyze(votes,ids,"s00",{}),defaults);
assert.equal(Object.isFrozen(DEFAULT_ANALYSIS_OPTIONS),true);
assert.equal("diagnostics" in defaults,false);
assert.equal(analyze(votes,ids,undefined,{minSubstantiveVotes:13}).eligible,0);
const collecting=analyze(votes,ids,undefined,{minSessions:13});
assert.equal(collecting.status,"collecting");
assert.equal(collecting.minimum,13);
assert.equal(analyze(votes,ids,undefined,{minOpinionVotes:13}).status,"collecting");
assert.equal(analyze(votes,ids,undefined,{minRetainedOpinions:13}).status,"collecting");
assert.equal(analyze(votes,ids,undefined,{minGroupSize:7}).status,"unclear");
assert.deepEqual(analyze(votes,ids,undefined,{minBridgeVotes:7}).bridges,[]);
assert.deepEqual(defaults.bridges,[]);
assert.equal(analyze(votes,ids,undefined,{minBridgeAgreement:0,minBridgeVotes:3,minBridgeLowerBound:0}).bridges.length,ids.length);
assert.equal(analyze(votes,ids,undefined,{pcaIterations:1,kMeansIterations:1}).status,"ready");

const sampled=analyze(votes,ids,"s00",{
  silhouetteTargetsPerGroup:3,silhouetteReferencesPerGroup:2,
});
assert.equal(sampled.status,"ready");
assert.equal(sampled.silhouetteApproximate,true);
assert.equal(sampled.silhouetteMethod,"deterministic-stratified-3-targets-2-references-per-group");
assert.equal(sampled.points.filter(p=>p.mine).length,1);
assert.equal(defaults.silhouetteMethod,"exact");
const {diagnostics}=analyzeAccumulated(acc,{maxGroups:3,starts:2});
assert.equal(diagnostics.inputSessions,12);
assert.equal(diagnostics.eligibleSessions,12);
assert.equal(diagnostics.filteredSessions,0);
assert.equal(diagnostics.retainedOpinions,12);
assert.equal(diagnostics.filteredOpinions,0);
assert.equal(diagnostics.overlapConnected,true);
assert.equal(diagnostics.bestGroupCount,2);
assert.equal(diagnostics.bestSilhouette,1);
assert.ok(Math.abs(diagnostics.explained!-1)<1e-10);
assert.equal(diagnostics.candidates.length,4);
assert.deepEqual(diagnostics.candidates.map(c=>[c.groupCount,c.start]),[[2,0],[2,1],[3,0],[3,1]]);
assert.deepEqual(diagnostics.candidates[0].sizes,[6,6]);
assert.equal(diagnostics.candidates[2].silhouette,null);
assert.equal(analyzeAccumulated(acc,{minOpinionVotes:13}).diagnostics.retainedOpinions,0);
assert.equal(analyzeAccumulated(acc,{minSubstantiveVotes:13}).diagnostics.filteredSessions,12);

// Failed publication threshold must still expose the candidate quality for sweeps.
let seed=123456789;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const noise:Vote[]=Array.from({length:80},(_,s)=>ids.map(opinion_id=>({
  session_id:`n${s}`,opinion_id,value:random()<.5?-1:1,
}))).flat();
const noisy=analyzeAccumulated(new AnalysisAccumulator(ids).add(noise),{minSilhouette:1});
assert.equal(noisy.analysis.status,"unclear");
assert.equal(noisy.analysis.silhouette,undefined);
assert.equal(noisy.analysis.explained,undefined);
assert.ok(noisy.diagnostics.bestSilhouette!==null&&noisy.diagnostics.bestSilhouette<1);
assert.ok(noisy.diagnostics.explained!==null&&noisy.diagnostics.explained>0);
assert.ok(noisy.diagnostics.bestGroupCount!==null);
assert.equal(noisy.diagnostics.candidates.length,12);
const accepted=analyzeAccumulated(new AnalysisAccumulator(ids).add(noise),{minSilhouette:-1});
assert.equal(accepted.analysis.status,"ready");
assert.equal(accepted.analysis.silhouette,noisy.diagnostics.bestSilhouette);

for(const key of Object.keys(DEFAULT_ANALYSIS_OPTIONS) as (keyof AnalysisOptions)[]){
  for(const value of [NaN,Infinity,-Infinity]){
    assert.throws(()=>analyze([],[],undefined,{[key]:value}),RangeError,key);
  }
  if(!["minSilhouette","minBridgeAgreement","minBridgeLowerBound","bridgeWilsonZ"].includes(key)){
    for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
      assert.throws(()=>analyzeAccumulated(acc,{[key]:value}),RangeError,key);
    }
  }
}
for(const maxGroups of [1,255,256])assert.throws(()=>analyze([],[],undefined,{maxGroups}),RangeError);
for(const minSilhouette of [-1.01,1.01])assert.throws(()=>analyze([],[],undefined,{minSilhouette}),RangeError);
for(const minBridgeAgreement of [-.01,1.01])assert.throws(()=>analyze([],[],undefined,{minBridgeAgreement}),RangeError);
assert.doesNotThrow(()=>analyze([],[],undefined,{maxGroups:254,minSilhouette:-1,minBridgeAgreement:0}));
assert.doesNotThrow(()=>analyze([],[],undefined,{minSilhouette:1,minBridgeAgreement:1}));
console.log("PASS: consistent defaults, experiment overrides, threshold-independent diagnostics, sampling metadata, and option validation.");
