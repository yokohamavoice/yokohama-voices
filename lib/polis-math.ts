/**
 * Adapted from Polis, Copyright (C) 2012-present, The Authors. AGPL-3.0.
 * Upstream 28b427324f751c8f1e42ab5df3d5111fe9f26db0:
 * math/src/polismath/math/pca.clj; conversation.clj (group-aware consensus).
 * Reference implementation: all eligible sessions enter PCA, k-means and
 * consensus. Only silhouette evaluation uses deterministic comparison samples.
 * Covariance is accumulated from sparse observed entries; no N x M float copy.
 */
export type Vote = {session_id:string; opinion_id:string; value:number};
export type Analysis = {
  status:string; message:string; eligible:number; minimum:number;
  points:{x:number;y:number;group:number;mine:boolean}[];
  groups:{id:number;size:number}[];
  bridges:{id:string;score:number;groups:{id:number;agree:number;seen:number;rate:number;lowerBound?:number}[]}[];
  explained?:number; silhouette?:number; silhouetteApproximate?:boolean;
  silhouetteMethod?:string;
};
/** Persisted daily coordinate system. It contains no session identifiers. */
export type ProjectionModel = {
  version:1;
  opinionIds:string[];
  means:number[];
  components:[number[],number[]];
  minSubstantiveVotes:number;
  centers:{x:number;y:number;group:number}[];
};
/** Private state for the next daily fit; never include sessionIds in public JSON. */
export type AnalysisWarmStart = {
  model:ProjectionModel;
  sessionIds:string[];
  groups:number[];
};
export type ProjectedParticipant = {x:number;y:number;group:number;mine:true};

/** Project just this participant, keeping the daily means, axes and groups fixed. */
export function projectParticipant(model:ProjectionModel,votes:Record<string,number>):ProjectedParticipant|null {
  const m=model.opinionIds.length;
  if(model.version!==1||!m||model.means.length!==m||model.components.length!==2||
    model.components.some(axis=>axis.length!==m)||!model.centers.length)return null;
  let x=0,y=0,observed=0,substantive=0;
  for(let j=0;j<m;j++){
    const value=votes[model.opinionIds[j]];
    // A pass is observed zero; a missing or unrelated answer is mean-imputed.
    if(value!==-1&&value!==0&&value!==1)continue;
    observed++;if(value!==0)substantive++;
    const centered=value-model.means[j];
    x+=centered*model.components[0][j];y+=centered*model.components[1][j];
  }
  if(substantive<model.minSubstantiveVotes)return null;
  const scale=Math.sqrt(m/Math.max(observed,1));x*=scale;y*=scale;
  if(!Number.isFinite(x)||!Number.isFinite(y))return null;
  let best=Infinity,group=-1;
  for(const center of model.centers){
    const dx=x-center.x,dy=y-center.y,d=dx*dx+dy*dy;
    if(d<best){best=d;group=center.group;}
  }
  return group<0?null:{x,y,group,mine:true};
}
const MISSING = -2;
const SLAB_ROWS = 2048;
const MAX_COVARIANCE_CELLS = 4_000_000;
const MAX_DENSE_TRIPLES = 4_000_000;
/** Experiment controls; omitted values retain the production defaults. */
export type AnalysisOptions = Readonly<{
  minSubstantiveVotes:number;
  minSessions:number;
  minOpinionVotes:number;
  minRetainedOpinions:number;
  pcaIterations:number;
  kMeansIterations:number;
  minGroupSize:number;
  maxGroups:number;
  starts:number;
  minSilhouette:number;
  silhouetteTargetsPerGroup:number;
  silhouetteReferencesPerGroup:number;
  minBridgeVotes:number;
  minBridgeAgreement:number;
  bridgeWilsonZ:number;
  minBridgeLowerBound:number;
}>;
export const DEFAULT_ANALYSIS_OPTIONS:AnalysisOptions = Object.freeze({
  minSubstantiveVotes:6, minSessions:80, minOpinionVotes:3,
  minRetainedOpinions:6, pcaIterations:100, kMeansIterations:60,
  minGroupSize:3, maxGroups:4, starts:4, minSilhouette:.45,
  silhouetteTargetsPerGroup:256, silhouetteReferencesPerGroup:128,
  minBridgeVotes:10, minBridgeAgreement:.6,
  bridgeWilsonZ:1.96, minBridgeLowerBound:.5,
});
export type AnalysisDiagnostics = {
  inputSessions:number; eligibleSessions:number; filteredSessions:number;
  inputOpinions:number; retainedOpinions:number|null; filteredOpinions:number|null;
  overlapConnected:boolean|null; explained:number|null;
  bestSilhouette:number|null; bestGroupCount:number|null;
  pcaIterations:[number,number]; pcaWarmStarted:[boolean,boolean];
  candidates:{groupCount:number;start:number;silhouette:number|null;sizes:number[]|null;warmStart?:boolean;iterations?:number}[];
};
function analysisOptions(overrides:Partial<AnalysisOptions>):AnalysisOptions {
  const options={...DEFAULT_ANALYSIS_OPTIONS,...overrides};
  for(const key of Object.keys(DEFAULT_ANALYSIS_OPTIONS) as (keyof AnalysisOptions)[]){
    const value=options[key];
    if(!Number.isFinite(value))throw new RangeError(`${key} must be finite`);
    if(key==="minSilhouette"){
      if(value< -1||value>1)throw new RangeError(`${key} must be between -1 and 1`);
    }else if(key==="minBridgeAgreement"||key==="minBridgeLowerBound"){
      if(value<0||value>1)throw new RangeError(`${key} must be between 0 and 1`);
    }else if(key==="bridgeWilsonZ"){
      if(value<0||value>10)throw new RangeError(`${key} must be between 0 and 10`);
    }else if(!Number.isSafeInteger(value)||value<1){
      throw new RangeError(`${key} must be a positive safe integer`);
    }
  }
  // Labels use Uint8Array, reserving 255 as the unassigned sentinel.
  if(options.maxGroups<2||options.maxGroups>254)throw new RangeError("maxGroups must be between 2 and 254");
  return options;
}

/** Incremental input; pages need not be sorted. Duplicate pairs overwrite. */
export class AnalysisAccumulator {
  readonly opinionIds:string[];
  readonly sessionIds:string[]=[];
  readonly substantive:number[]=[];
  private columns:Map<string,number>;
  private sessions=new Map<string,number>();
  private slabs:Int8Array[]=[];
  constructor(opinionIds:string[]){
    this.opinionIds=[...new Set(opinionIds)];
    this.columns=new Map(this.opinionIds.map((id,j)=>[id,j]));
  }
  add(votesPage:readonly Vote[]):this {
    const width=this.opinionIds.length;
    for(const vote of votesPage){
      if(vote.value!==-1&&vote.value!==0&&vote.value!==1)continue;
      const column=this.columns.get(vote.opinion_id);if(column===undefined)continue;
      let row=this.sessions.get(vote.session_id);
      if(row===undefined){
        row=this.sessionIds.length;this.sessions.set(vote.session_id,row);
        this.sessionIds.push(vote.session_id);this.substantive.push(0);
        if(row%SLAB_ROWS===0)this.slabs.push(new Int8Array(SLAB_ROWS*width).fill(MISSING));
      }
      const slab=this.slabs[Math.floor(row/SLAB_ROWS)],offset=(row%SLAB_ROWS)*width+column;
      const previous=slab[offset];
      if(previous===-1||previous===1)this.substantive[row]--;
      if(vote.value===-1||vote.value===1)this.substantive[row]++;
      slab[offset]=vote.value;
    }
    return this;
  }
  value(row:number,column:number):number {
    return this.slabs[Math.floor(row/SLAB_ROWS)][(row%SLAB_ROWS)*this.opinionIds.length+column];
  }
}

export function consensus(groups:{agree:number;seen:number}[]){
  return groups.reduce((product,g)=>product*(g.agree+1)/(g.seen+2),1);
}
/** Wilson score lower endpoint, without continuity correction.
 * z=1.96 corresponds to the lower endpoint of the nominal two-sided 95% interval
 * for a fixed binomial sample. Here it is only a display-evidence heuristic:
 * routing, inferred groups and repeated selection do not satisfy that design.
 * Reference: https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm
 */
export function wilsonLowerBound(agree:number,seen:number,z=DEFAULT_ANALYSIS_OPTIONS.bridgeWilsonZ):number {
  if(!Number.isSafeInteger(agree)||!Number.isSafeInteger(seen)||agree<0||seen<agree||!Number.isFinite(z)||z<0||z>10)throw new RangeError("Invalid Wilson counts or z");
  if(!seen)return 0;
  const rate=agree/seen,z2=z*z;
  return Math.max(0,(rate+z2/(2*seen)-z*Math.sqrt(rate*(1-rate)/seen+z2/(4*seen*seen)))/(1+z2/seen));
}
/** A zero lower-bound threshold disables this extra gate for legacy comparisons. */
export function bridgeHasEvidence(group:{agree:number;seen:number},overrides:Partial<AnalysisOptions>={}):boolean {
  const options=analysisOptions(overrides);
  return group.seen>=options.minBridgeVotes&&group.agree/group.seen>=options.minBridgeAgreement&&
    (options.minBridgeLowerBound===0||wilsonLowerBound(group.agree,group.seen,options.bridgeWilsonZ)>options.minBridgeLowerBound);
}
const dot=(a:Float64Array,b:Float64Array)=>{let total=0;for(let i=0;i<a.length;i++)total+=a[i]*b[i];return total;};
const norm=(v:Float64Array)=>Math.sqrt(dot(v,v));
function canonicalize(v:Float64Array){let pivot=0;for(let j=1;j<v.length;j++)if(Math.abs(v[j])>Math.abs(v[pivot]))pivot=j;if(v[pivot]<0)for(let j=0;j<v.length;j++)v[j]=-v[j];}
type Multiply=(input:Float64Array,output:Float64Array)=>void;
const PCA_CONVERGENCE_SQUARED=1e-16;
/** A small cold component lets a changed dominant direction enter a warm fit. */
function previousAxes(previous:AnalysisWarmStart|undefined,ids:string[]):[Float64Array,Float64Array]|null {
  const model=previous?.model;
  if(!model||model.version!==1||model.components.length!==2||
    model.components.some(axis=>axis.length!==model.opinionIds.length||axis.some(value=>!Number.isFinite(value))))return null;
  const oldColumns=new Map(model.opinionIds.map((id,j)=>[id,j]));
  if(oldColumns.size!==model.opinionIds.length)return null;
  const overlap=ids.reduce((count,id)=>count+Number(oldColumns.has(id)),0);
  // A very different feature space gets the ordinary deterministic initialization.
  if(overlap<2||overlap/Math.max(ids.length,model.opinionIds.length)<.8)return null;
  return [0,1].map(axis=>Float64Array.from(ids,id=>{
    const column=oldColumns.get(id);return column===undefined?0:model.components[axis][column];
  })) as [Float64Array,Float64Array];
}
function component(width:number,axis:number,multiply:Multiply,iterations:number,initial?:Float64Array):{vector:Float64Array;iterations:number;warmStart:boolean} {
  const cold=Float64Array.from({length:width},(_,i)=>Math.sin((i+1)*(axis+1)*1.731)+.2);
  const coldNorm=norm(cold);for(let j=0;j<width;j++)cold[j]/=coldNorm;
  const warmStart=!!initial&&norm(initial)>1e-10;
  let v=warmStart?initial!.slice():cold.slice();
  if(warmStart){const magnitude=norm(v);for(let j=0;j<width;j++)v[j]=v[j]/magnitude+1e-3*cold[j];}
  const initialNorm=norm(v);for(let j=0;j<width;j++)v[j]/=initialNorm;
  let next=new Float64Array(width),used=0;
  for(let iteration=0;iteration<iterations;iteration++){
    used++;
    multiply(v,next);const magnitude=norm(next);
    if(magnitude<1e-10){
      // An old component may have lost all variance. Retry from the cold seed.
      if(warmStart&&iteration===0)return component(width,axis,multiply,iterations);
      return {vector:new Float64Array(width),iterations:used,warmStart};
    }
    for(let j=0;j<width;j++)next[j]/=magnitude;
    const sign=dot(v,next)<0?-1:1;let change=0;
    for(let j=0;j<width;j++){const difference=next[j]-sign*v[j];change+=difference*difference;}
    const old=v;v=next;next=old;
    if(change<=PCA_CONVERGENCE_SQUARED)break;
  }
  canonicalize(v);return {vector:v,iterations:used,warmStart};
}

class UnionFind {
  parent:Int32Array; sizes:Uint32Array; components:number;
  constructor(n:number){this.parent=Int32Array.from({length:n},(_,i)=>i);this.sizes=new Uint32Array(n).fill(1);this.components=n;}
  find(i:number):number{while(this.parent[i]!==i){this.parent[i]=this.parent[this.parent[i]];i=this.parent[i];}return i;}
  join(a:number,b:number){a=this.find(a);b=this.find(b);if(a===b)return;if(this.sizes[a]<this.sizes[b])[a,b]=[b,a];this.parent[b]=a;this.sizes[a]+=this.sizes[b];this.components--;}
}

/** Exact equivalence to edges with >=3 shared substantive retained columns. */
function connected(acc:AnalysisAccumulator,rows:number[],columns:number[]):boolean {
  const n=rows.length,m=columns.length,uf=new UnionFind(n);
  const possible=m*(m-1)*(m-2)/6;
  const dense=possible<=MAX_DENSE_TRIPLES?new Int32Array(possible):null;
  const sparse=dense?null:new Map<number,number>();
  const pairRank=Float64Array.from({length:m},(_,j)=>j*(j-1)/2);
  const tripleRank=Float64Array.from({length:m},(_,j)=>j*(j-1)*(j-2)/6);
  const observed=new Uint32Array(m);
  for(let i=0;i<n;i++){
    let count=0;
    for(let j=0;j<m;j++){const value=acc.value(rows[i],columns[j]);if(value===-1||value===1)observed[count++]=j;}
    for(let c=2;c<count;c++)for(let b=1;b<c;b++){
      const base=tripleRank[observed[c]]+pairRank[observed[b]];
      for(let a=0;a<b;a++){
        const key=base+observed[a];
        const representative=dense?dense[key]:(sparse!.get(key)||0);
        if(representative)uf.join(i,representative-1);
        else if(dense)dense[key]=i+1;else sparse!.set(key,i+1);
      }
    }
  }
  return uf.components===1;
}

function stableHash(text:string,salt:number):number {
  let value=(2166136261^salt)>>>0;
  for(let i=0;i<text.length;i++){value^=text.charCodeAt(i);value=Math.imul(value,16777619);}
  value^=value>>>16;value=Math.imul(value,0x7feb352d);value^=value>>>15;value=Math.imul(value,0x846ca68b);return (value^(value>>>16))>>>0;
}
function sampleOrder(ids:string[],salt:number):number[]{
  const hashes=Uint32Array.from(ids,id=>stableHash(id,salt));
  return Array.from({length:ids.length},(_,i)=>i).sort((a,b)=>hashes[a]-hashes[b]||a-b);
}
function sampleByGroup(labels:Uint8Array,k:number,order:number[],maximum:number):number[][] {
  const groups=Array.from({length:k},()=>[] as number[]);let complete=0;
  for(const index of order){const group=groups[labels[index]];if(group.length>=maximum)continue;group.push(index);if(group.length===maximum&&++complete===k)break;}
  return groups;
}
function distance(points:Float64Array,i:number,j:number){return Math.hypot(points[i*2]-points[j*2],points[i*2+1]-points[j*2+1]);}
function silhouette(points:Float64Array,labels:Uint8Array,sizes:Uint32Array,targetOrder:number[],referenceOrder:number[],options:AnalysisOptions){
  const k=sizes.length,targets=sampleByGroup(labels,k,targetOrder,options.silhouetteTargetsPerGroup),refs=sampleByGroup(labels,k,referenceOrder,options.silhouetteReferencesPerGroup);
  let total=0;
  for(let group=0;group<k;group++){
    let groupSum=0;
    for(const i of targets[group]){
      let own=0,ownCount=0,other=Infinity;
      for(let g=0;g<k;g++){
        let sum=0,count=0;
        for(const j of refs[g]){if(i===j)continue;sum+=distance(points,i,j);count++;}
        if(g===group){own=sum;ownCount=count;}else if(count)other=Math.min(other,sum/count);
      }
      if(!ownCount||!Number.isFinite(other))continue;
      const a=own/ownCount;groupSum+=(other-a)/Math.max(a,other,1e-9);
    }
    // Stratified target sampling: weight each stratum by its full population.
    total+=groupSum/targets[group].length*sizes[group]/labels.length;
  }
  return {score:total,approximate:[...sizes].some(n=>n>options.silhouetteTargetsPerGroup||n>options.silhouetteReferencesPerGroup)};
}
type Cluster={labels:Uint8Array;centers:Float64Array;sizes:Uint32Array;silhouette:number;approximate:boolean;iterations:number};
function cluster(points:Float64Array,k:number,start:number,targetOrder:number[],referenceOrder:number[],options:AnalysisOptions,initialCenters?:Float64Array):Cluster|null {
  const n=points.length/2,centers=initialCenters?.slice()??new Float64Array(k*2),nearest=new Float64Array(n).fill(Infinity);
  if(!initialCenters){
  centers[0]=points[2*start];centers[1]=points[2*start+1];
  for(let c=1;c<k;c++){
    let best=-1,selected=0;
    for(let i=0;i<n;i++){
      const dx=points[2*i]-centers[2*(c-1)],dy=points[2*i+1]-centers[2*(c-1)+1];
      nearest[i]=Math.min(nearest[i],dx*dx+dy*dy);if(nearest[i]>best){best=nearest[i];selected=i;}
    }
    if(best<1e-16)return null;centers[2*c]=points[2*selected];centers[2*c+1]=points[2*selected+1];
  }
  }
  const labels=new Uint8Array(n).fill(255),sizes=new Uint32Array(k),sums=new Float64Array(k*2);
  let iterations=0;
  for(let iteration=0;iteration<options.kMeansIterations;iteration++){
    iterations++;
    sizes.fill(0);sums.fill(0);let changed=false;
    for(let i=0;i<n;i++){
      const x=points[2*i],y=points[2*i+1];let best=Infinity,label=0;
      for(let g=0;g<k;g++){const dx=x-centers[2*g],dy=y-centers[2*g+1],d=dx*dx+dy*dy;if(d<best){best=d;label=g;}}
      if(labels[i]!==label)changed=true;labels[i]=label;sizes[label]++;sums[2*label]+=x;sums[2*label+1]+=y;
    }
    for(let g=0;g<k;g++){if(sizes[g]<options.minGroupSize)return null;centers[2*g]=sums[2*g]/sizes[g];centers[2*g+1]=sums[2*g+1]/sizes[g];}
    if(!changed)break;
  }
  const quality=silhouette(points,labels,sizes,targetOrder,referenceOrder,options);
  return {labels,centers,sizes,silhouette:quality.score,approximate:quality.approximate,iterations};
}

/** Re-center previous memberships in today's coordinate system, whose axes may move. */
function previousCenters(previous:AnalysisWarmStart|undefined,sessionIds:string[],points:Float64Array,options:AnalysisOptions):Float64Array|null {
  if(!previous||previous.sessionIds.length!==previous.groups.length)return null;
  const oldGroups=[...new Set(previous.groups)].sort((a,b)=>a-b),k=oldGroups.length;
  if(k<2||k>options.maxGroups||oldGroups.some(group=>!Number.isSafeInteger(group)||group<0))return null;
  const remap=new Map(oldGroups.map((group,index)=>[group,index]));
  const membership=new Map(previous.sessionIds.map((id,i)=>[id,remap.get(previous.groups[i])!]));
  const counts=new Uint32Array(k),centers=new Float64Array(k*2);
  for(let i=0;i<sessionIds.length;i++){
    const group=membership.get(sessionIds[i]);if(group===undefined)continue;
    counts[group]++;centers[group*2]+=points[i*2];centers[group*2+1]+=points[i*2+1];
  }
  for(let group=0;group<k;group++){
    if(counts[group]<options.minGroupSize)return null;
    centers[group*2]/=counts[group];centers[group*2+1]/=counts[group];
  }
  return centers;
}

export function analyzeAccumulated(acc:AnalysisAccumulator,overrides:Partial<AnalysisOptions>={},previous?:AnalysisWarmStart):{analysis:Analysis;sessionIds:string[];diagnostics:AnalysisDiagnostics;model:ProjectionModel|null} {
  const options=analysisOptions(overrides);
  // Diagnostics are returned separately so they never enter the public Analysis payload.
  const diagnostics:AnalysisDiagnostics={inputSessions:acc.sessionIds.length,eligibleSessions:0,filteredSessions:0,inputOpinions:acc.opinionIds.length,retainedOpinions:null,filteredOpinions:null,overlapConnected:null,explained:null,bestSilhouette:null,bestGroupCount:null,pcaIterations:[0,0],pcaWarmStarted:[false,false],candidates:[]};
  const base:Analysis={status:"collecting",message:"回答が集まると、意見の傾向と共通点が見えてきます。",eligible:0,minimum:options.minSessions,points:[],groups:[],bridges:[]};
  let model:ProjectionModel|null=null;
  const result=(analysis:Analysis,sessionIds:string[]=[])=>({analysis,sessionIds,diagnostics,model});
  const rows=acc.sessionIds.map((_,i)=>i).filter(i=>acc.substantive[i]>=options.minSubstantiveVotes).sort((a,b)=>acc.sessionIds[a]<acc.sessionIds[b]?-1:acc.sessionIds[a]>acc.sessionIds[b]?1:0);
  const n=rows.length,width=acc.opinionIds.length;base.eligible=n;diagnostics.eligibleSessions=n;diagnostics.filteredSessions=acc.sessionIds.length-n;if(n<options.minSessions)return result(base);
  const counts=new Uint32Array(width),sums=new Float64Array(width);
  for(const row of rows)for(let j=0;j<width;j++){const v=acc.value(row,j);if(v!==MISSING){counts[j]++;sums[j]+=v;}}
  const columns=Array.from({length:width},(_,j)=>j).filter(j=>counts[j]>=options.minOpinionVotes),m=columns.length;
  diagnostics.retainedOpinions=m;diagnostics.filteredOpinions=width-m;
  if(m<options.minRetainedOpinions)return result({...base,message:"同じ意見への回答がまだ少ないため、グループ分けを保留しています。"});
  diagnostics.overlapConnected=connected(acc,rows,columns);
  if(!diagnostics.overlapConnected)return result({...base,message:"回答した意見の重なりが足りないため、グループ分けを保留しています。"});
  const means=Float64Array.from(columns,j=>sums[j]/counts[j]);
  const covariance=m*m<=MAX_COVARIANCE_CELLS?new Float64Array(m*m):null;
  const positions=new Uint32Array(m),values=new Float64Array(m),observedCount=new Uint32Array(n);
  let total=0;
  for(let i=0;i<n;i++){
    let count=0;
    for(let j=0;j<m;j++){const v=acc.value(rows[i],columns[j]);if(v===MISSING)continue;positions[count]=j;values[count++]=v-means[j];}
    observedCount[i]=count;
    for(let a=0;a<count;a++){
      const x=values[a],j=positions[a];total+=x*x;
      if(covariance)for(let b=0;b<=a;b++)covariance[j*m+positions[b]]+=x*values[b];
    }
  }
  if(total<1e-8)return result({...base,status:"uniform",message:"今の回答には、グループを分けるほどの違いがありません。"});
  if(covariance)for(let j=0;j<m;j++)for(let k=0;k<j;k++)covariance[k*m+j]=covariance[j*m+k];
  const multiply:Multiply=(input,output)=>{
    output.fill(0);
    if(covariance){for(let j=0;j<m;j++){let value=0;for(let k=0;k<m;k++)value+=covariance[j*m+k]*input[k];output[j]=value;}return;}
    // Same covariance operator without allocating M x M storage for many columns.
    for(const row of rows){let count=0,projection=0;for(let j=0;j<m;j++){const v=acc.value(row,columns[j]);if(v===MISSING)continue;positions[count]=j;values[count++]=v-means[j];projection+=(v-means[j])*input[j];}for(let a=0;a<count;a++)output[positions[a]]+=values[a]*projection;}
  };
  const warmAxes=previousAxes(previous,columns.map(column=>acc.opinionIds[column]));
  const firstComponent=component(m,0,multiply,options.pcaIterations,warmAxes?.[0]),pc1=firstComponent.vector,projected=new Float64Array(m),product=new Float64Array(m);
  const deflated:Multiply=(input,output)=>{
    const amount=dot(input,pc1);for(let j=0;j<m;j++)projected[j]=input[j]-amount*pc1[j];
    multiply(projected,output);const remove=dot(output,pc1);for(let j=0;j<m;j++)output[j]-=remove*pc1[j];
  };
  const secondComponent=component(m,1,deflated,options.pcaIterations,warmAxes?.[1]),pc2=secondComponent.vector;
  diagnostics.pcaIterations=[firstComponent.iterations,secondComponent.iterations];
  diagnostics.pcaWarmStarted=[firstComponent.warmStart,secondComponent.warmStart];
  model={version:1,opinionIds:columns.map(column=>acc.opinionIds[column]),means:[...means],components:[[...pc1],[...pc2]],minSubstantiveVotes:options.minSubstantiveVotes,centers:[]};
  multiply(pc1,product);const first=dot(pc1,product);multiply(pc2,product);const explained=(first+dot(pc2,product))/total;
  diagnostics.explained=explained;
  const points=new Float64Array(n*2);
  for(let i=0;i<n;i++){
    let x=0,y=0;for(let j=0;j<m;j++){const v=acc.value(rows[i],columns[j]);if(v===MISSING)continue;const centered=v-means[j];x+=centered*pc1[j];y+=centered*pc2[j];}
    const scale=Math.sqrt(m/Math.max(observedCount[i],1));points[2*i]=x*scale;points[2*i+1]=y*scale;
  }
  const sessionIds=rows.map(row=>acc.sessionIds[row]),targetOrder=sampleOrder(sessionIds,0x6a09e667),referenceOrder=sampleOrder(sessionIds,0xbb67ae85);
  let best:Cluster|null=null,warmGroupCount:number|null=null;
  const warmCenters=previousCenters(previous,sessionIds,points,options);
  if(warmCenters){
    const k=warmCenters.length/2,candidate=cluster(points,k,0,targetOrder,referenceOrder,options,warmCenters);
    diagnostics.candidates.push({groupCount:k,start:0,silhouette:candidate?.silhouette??null,sizes:candidate?[...candidate.sizes]:null,warmStart:true,iterations:candidate?.iterations});
    if(candidate){best=candidate;warmGroupCount=k;}
  }
  for(let k=2;k<=Math.min(options.maxGroups,Math.floor(n/options.minGroupSize));k++)for(let start=k===warmGroupCount?1:0;start<Math.min(options.starts,n);start++){
    const candidate=cluster(points,k,targetOrder[Math.floor(start*n/Math.min(options.starts,n))],targetOrder,referenceOrder,options);
    diagnostics.candidates.push({groupCount:k,start,silhouette:candidate?.silhouette??null,sizes:candidate?[...candidate.sizes]:null,warmStart:false,iterations:candidate?.iterations});
    if(candidate&&(!best||candidate.silhouette>best.silhouette))best=candidate;
  }
  diagnostics.bestSilhouette=best?.silhouette??null;diagnostics.bestGroupCount=best?.sizes.length??null;
  if(!best||best.silhouette<options.minSilhouette)return result({...base,status:"unclear",message:"はっきりした意見群はまだ見つかっていません。回答を重ねて確認します。"});
  const k=best.sizes.length,order=Array.from({length:k},(_,g)=>g).sort((a,b)=>best!.centers[2*a]-best!.centers[2*b]||best!.centers[2*a+1]-best!.centers[2*b+1]),remap=new Uint8Array(k);
  model.centers=order.map((old,group)=>({x:best!.centers[2*old],y:best!.centers[2*old+1],group}));
  order.forEach((old,g)=>remap[old]=g);const labels=best.labels;for(let i=0;i<n;i++)labels[i]=remap[labels[i]];
  const groups=order.map((old,id)=>({id,size:best!.sizes[old]})),seen=new Uint32Array(k*width),agree=new Uint32Array(k*width);
  for(let i=0;i<n;i++)for(let j=0;j<width;j++){const v=acc.value(rows[i],j);if(v===MISSING)continue;const index=labels[i]*width+j;seen[index]++;if(v===-1)agree[index]++;}
  const bridges=acc.opinionIds.map((id,j)=>{const counts=groups.map(g=>{const index=g.id*width+j;return {id:g.id,agree:agree[index],seen:seen[index],rate:seen[index]?agree[index]/seen[index]:0,lowerBound:wilsonLowerBound(agree[index],seen[index],options.bridgeWilsonZ)};});return {id,score:consensus(counts),groups:counts};}).filter(b=>b.groups.every(g=>bridgeHasEvidence(g,options))).sort((a,b)=>b.score-a.score);
  return result({...base,status:"ready",message:"回答傾向が似たセッションをまとめています。",points:Array.from({length:n},(_,i)=>({x:points[2*i],y:points[2*i+1],group:labels[i],mine:false})),groups,bridges,explained,silhouette:best.silhouette,silhouetteApproximate:best.approximate,silhouetteMethod:best.approximate?`deterministic-stratified-${options.silhouetteTargetsPerGroup}-targets-${options.silhouetteReferencesPerGroup}-references-per-group`:"exact"},sessionIds);
}

/** Compatibility wrapper. Shared cached analysis remains independent of mine. */
export function analyze(votes:Vote[],opinionIds:string[],mine?:string,overrides:Partial<AnalysisOptions>={}):Analysis {
  const {analysis,sessionIds}=analyzeAccumulated(new AnalysisAccumulator(opinionIds).add(votes),overrides);
  if(mine){const index=sessionIds.indexOf(mine);if(index>=0)analysis.points=analysis.points.map((point,i)=>i===index?{...point,mine:true}:point);}
  return analysis;
}
