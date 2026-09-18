import assert from 'node:assert/strict';
import {AnalysisAccumulator,analyzeAccumulated,analyze} from '../lib/polis-math.ts';
const ids=Array.from({length:100},(_,i)=>`o${i}`);
const fixture=(count:number)=>{const acc=new AnalysisAccumulator(ids);for(let first=0;first<count;first+=500){const page=[];for(let i=first;i<Math.min(count,first+500);i++)for(let j=0;j<20;j++)page.push({session_id:`s${String(i).padStart(8,'0')}`,opinion_id:ids[j],value:j<3?-1:i%2?-1:1});acc.add(page);}return acc;};
for(const n of [1001,10000,100000]){const acc=fixture(n),start=performance.now(),r=analyzeAccumulated(acc);assert.equal(r.analysis.status,'ready');assert.equal(r.analysis.eligible,n);assert.equal(r.analysis.points.length,n);assert.equal(r.analysis.groups.reduce((sum,g)=>sum+g.size,0),n);assert.ok(r.analysis.bridges.some(b=>b.id==='o0'));assert.ok(r.analysis.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));assert.ok(!r.analysis.points.some(p=>p.mine));assert.ok(r.analysis.silhouetteApproximate);console.log(`PASS: ${n.toLocaleString()} sessions included; local math ${Math.round(performance.now()-start)}ms.`);}
const votes=Array.from({length:24},(_,i)=>Array.from({length:12},(_,j)=>({session_id:`p${i}`,opinion_id:ids[j],value:j<3?-1:i%2?-1:1}))).flat();
const one=analyze(votes,ids),paged=analyzeAccumulated(new AnalysisAccumulator(ids).add(votes.slice(0,75)).add(votes.slice(75))).analysis;
assert.deepEqual(one,paged);assert.deepEqual(analyze([...votes].reverse(),ids),one);assert.equal(analyze(votes,ids,'p1').points.filter(p=>p.mine).length,1);assert.ok(!one.points.some(p=>p.mine));
console.log('PASS: deterministic pagination/order, mine isolation and common agreement preserved.');
