import assert from "node:assert/strict";
import { ANALYSIS_ALGORITHM, matchesAnalysisConfiguration } from "../lib/analysis-cache-identity.ts";
import { DEFAULT_ANALYSIS_OPTIONS } from "../lib/polis-math.ts";

const current={algorithm:ANALYSIS_ALGORITHM,parameters:{...DEFAULT_ANALYSIS_OPTIONS}};
const matches=(snapshot:Parameters<typeof matchesAnalysisConfiguration>[0])=>
 matchesAnalysisConfiguration(snapshot,DEFAULT_ANALYSIS_OPTIONS);
assert.equal(matches(current),true);
assert.equal(matches({algorithm:ANALYSIS_ALGORITHM,parameters:Object.fromEntries(
 Object.entries(DEFAULT_ANALYSIS_OPTIONS).reverse(),
)}),true,"JSON key order must not change the cache identity");
assert.equal(matches({algorithm:"polis-math-v2-covariance-sampled-silhouette",parameters:current.parameters}),false);
assert.equal(matches({algorithm:ANALYSIS_ALGORITHM}),false,"legacy snapshots without parameters must be rebuilt");
assert.equal(matches({parameters:current.parameters}),false);
assert.equal(matches(null),false);
assert.equal(matches(undefined),false);
for(const parameters of [null,[],"defaults",{...current.parameters,unknown:1}]){
 assert.equal(matches({algorithm:ANALYSIS_ALGORITHM,parameters}),false);
}
for(const [key,value] of Object.entries(DEFAULT_ANALYSIS_OPTIONS)){
 const parameters:Record<string,number>={...DEFAULT_ANALYSIS_OPTIONS};
 delete parameters[key];
 assert.equal(matches({...current,parameters}),false,`${key}: missing parameter must invalidate`);
 parameters[key]=value+1;
 assert.equal(matches({...current,parameters}),false,`${key}: changed parameter must invalidate`);
 assert.equal(matches({...current,parameters:{...current.parameters,[key]:String(value)}}),false,`${key}: values must retain their types`);
}
console.log("PASS: cache identity rejects old algorithms and missing or changed parameters, independent of key order.");
