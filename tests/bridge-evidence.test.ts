import assert from 'node:assert/strict';
import {analyze,bridgeHasEvidence,wilsonLowerBound,DEFAULT_ANALYSIS_OPTIONS,type Vote} from '../lib/polis-math.ts';

assert.equal(wilsonLowerBound(0,0),0);
assert.equal(wilsonLowerBound(0,10),0);
assert.ok(Math.abs(wilsonLowerBound(10,10)-1/(1+1.96**2/10))<1e-12);
assert.equal(wilsonLowerBound(6,10,0),.6);
assert.equal(bridgeHasEvidence({agree:2,seen:3}),false);
assert.equal(bridgeHasEvidence({agree:9,seen:9}),false);
for(const [agree,seen,expected] of [[8,10,false],[9,10,true],[14,20,false],[15,20,true],[59,100,false],[60,100,true]] as const){
  assert.equal(bridgeHasEvidence({agree,seen}),expected,`${agree}/${seen}`);
}
assert.equal(bridgeHasEvidence({agree:2,seen:3},{minBridgeVotes:3,minBridgeLowerBound:0,bridgeWilsonZ:0}),true);
assert.equal(DEFAULT_ANALYSIS_OPTIONS.minGroupSize,3);
assert.equal(DEFAULT_ANALYSIS_OPTIONS.minSubstantiveVotes,6);

// Passes count in the denominator; unrelated responses and absence do not.
// Constrain k=2 to isolate bridge evidence from selecting extra response subgroups.
const ids=Array.from({length:20},(_,i)=>`b${i}`);
const make=(agree:number,pass=0,unrelated=0):Vote[]=>Array.from({length:40},(_,s)=>ids.map((id,j)=>({
  session_id:`s${String(s).padStart(2,'0')}`,opinion_id:id,
  value:j? (s<20?-1:1) : s%20<agree?-1:s%20<agree+pass?0:s%20<agree+pass+unrelated?2:1,
}))).flat();
assert.ok(analyze(make(15),ids,undefined,{maxGroups:2,minSessions:8}).bridges.some(b=>b.id==='b0'));
assert.ok(!analyze(make(14,6),ids,undefined,{maxGroups:2,minSessions:8}).bridges.some(b=>b.id==='b0'));
const flagged=analyze(make(14,0,6),ids,undefined,{maxGroups:2,minSessions:8});
const missing=analyze(make(14,0,6).filter(v=>v.value!==2),ids,undefined,{maxGroups:2,minSessions:8});
assert.deepEqual(flagged,missing);
const bridge=flagged.bridges.find(b=>b.id==='b0');
assert.ok(bridge);
assert.ok(bridge.groups.every(g=>g.agree===14&&g.seen===14&&g.lowerBound!>.5));
// A strongly separated three-person group is still shown, but cannot certify a bridge.
const tiny=Array.from({length:100},(_,s)=>ids.map((id,j)=>({session_id:`t${s}`,opinion_id:id,value:j?(s<97?-1:1):-1}))).flat();
const tinyResult=analyze(tiny,ids);
assert.equal(tinyResult.status,'ready');
assert.deepEqual(tinyResult.groups.map(g=>g.size).sort((a,b)=>a-b),[3,97]);
assert.deepEqual(tinyResult.bridges,[]);
for(const [agree,seen,z] of [[-1,10,1.96],[11,10,1.96],[1,-1,1.96],[1.5,10,1.96],[1,2,NaN],[1,2,-1],[1,2,11]])assert.throws(()=>wilsonLowerBound(agree,seen,z),RangeError);
for(const minBridgeLowerBound of [-.1,1.1])assert.throws(()=>analyze([],[],undefined,{minBridgeLowerBound}),RangeError);
for(const bridgeWilsonZ of [-.1,10.1])assert.throws(()=>analyze([],[],undefined,{bridgeWilsonZ}),RangeError);
console.log('PASS: bridge evidence boundaries, denominators, minimum votes, and visible small groups.');
