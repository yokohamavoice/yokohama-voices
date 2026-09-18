import assert from 'node:assert/strict';
import {distribution,draw} from '../lib/routing.ts';
const c=(id:string,agree=0,disagree=0,tagId='a')=>({id,agree,disagree,tagId,pass:0,unrelated:0});
for(const candidates of [[],[c('1')],[c('1'),c('2')],[c('1',50,50),c('2',100),c('3',0,0,'b')]]){
 const p=distribution(candidates,{a:3,b:0});if(p.length){assert.ok(Math.abs(p.reduce((n,x)=>n+x.probability,0)-1)<1e-12);assert.ok(p.every(x=>x.probability>0&&Number.isFinite(x.probability)));}else assert.equal(draw(p,.2),null);
}
const split=distribution([c('split',50,50),c('unanimous',100,0)],{});assert.ok(split[0].probability>split[1].probability);assert.ok(split[1].probability>0);
const newItem=distribution([{...c('old'),pass:100},c('new')],{});assert.ok(newItem[1].probability>newItem[0].probability);
const tags=distribution([c('a',0,0,'a'),c('b',0,0,'b')],{a:10,b:0});assert.ok(tags[1].probability>tags[0].probability);
assert.equal(distribution([c('only')],{})[0].probability,1);
console.log('PASS: auditable probabilities, disagreement/low-response/tag priorities, nonzero coverage and empty pool.');
