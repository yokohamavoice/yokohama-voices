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
  bridges:{id:string;score:number;groups:{id:number;agree:number;seen:number;rate:number}[]}[];
  explained?:number; silhouette?:number; silhouetteApproximate?:boolean;
  silhouetteMethod?:string;
};
const MISSING = -2;
const SLAB_ROWS = 2048;
const MAX_COVARIANCE_CELLS = 4_000_000;
const MAX_DENSE_TRIPLES = 4_000_000;
const TARGETS_PER_GROUP = 256;
const REFERENCES_PER_GROUP = 128;

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
const dot=(a:Float64Array,b:Float64Array)=>{let total=0;for(let i=0;i<a.length;i++)total+=a[i]*b[i];return total;};
const norm=(v:Float64Array)=>Math.sqrt(dot(v,v));
function canonicalize(v:Float64Array){let pivot=0;for(let j=1;j<v.length;j++)if(Math.abs(v[j])>Math.abs(v[pivot]))pivot=j;if(v[pivot]<0)for(let j=0;j<v.length;j++)v[j]=-v[j];}
type Multiply=(input:Float64Array,output:Float64Array)=>void;
function component(width:number,axis:number,multiply:Multiply):Float64Array {
  let v=Float64Array.from({length:width},(_,i)=>Math.sin((i+1)*(axis+1)*1.731)+.2);
  let next=new Float64Array(width);
  for(let iteration=0;iteration<100;iteration++){
    multiply(v,next);const magnitude=norm(next);if(magnitude<1e-10)return new Float64Array(width);
    for(let j=0;j<width;j++)next[j]/=magnitude;
    const old=v;v=next;next=old;
  }
  canonicalize(v);return v;
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
function silhouette(points:Float64Array,labels:Uint8Array,sizes:Uint32Array,targetOrder:number[],referenceOrder:number[]){
  const k=sizes.length,targets=sampleByGroup(labels,k,targetOrder,TARGETS_PER_GROUP),refs=sampleByGroup(labels,k,referenceOrder,REFERENCES_PER_GROUP);
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
  return {score:total,approximate:[...sizes].some(n=>n>TARGETS_PER_GROUP||n>REFERENCES_PER_GROUP)};
}
type Cluster={labels:Uint8Array;centers:Float64Array;sizes:Uint32Array;silhouette:number;approximate:boolean};
function cluster(points:Float64Array,k:number,start:number,targetOrder:number[],referenceOrder:number[]):Cluster|null {
  const n=points.length/2,centers=new Float64Array(k*2),nearest=new Float64Array(n).fill(Infinity);
  centers[0]=points[2*start];centers[1]=points[2*start+1];
  for(let c=1;c<k;c++){
    let best=-1,selected=0;
    for(let i=0;i<n;i++){
      const dx=points[2*i]-centers[2*(c-1)],dy=points[2*i+1]-centers[2*(c-1)+1];
      nearest[i]=Math.min(nearest[i],dx*dx+dy*dy);if(nearest[i]>best){best=nearest[i];selected=i;}
    }
    if(best<1e-16)return null;centers[2*c]=points[2*selected];centers[2*c+1]=points[2*selected+1];
  }
  const labels=new Uint8Array(n).fill(255),sizes=new Uint32Array(k),sums=new Float64Array(k*2);
  for(let iteration=0;iteration<60;iteration++){
    sizes.fill(0);sums.fill(0);let changed=false;
    for(let i=0;i<n;i++){
      const x=points[2*i],y=points[2*i+1];let best=Infinity,label=0;
      for(let g=0;g<k;g++){const dx=x-centers[2*g],dy=y-centers[2*g+1],d=dx*dx+dy*dy;if(d<best){best=d;label=g;}}
      if(labels[i]!==label)changed=true;labels[i]=label;sizes[label]++;sums[2*label]+=x;sums[2*label+1]+=y;
    }
    for(let g=0;g<k;g++){if(sizes[g]<3)return null;centers[2*g]=sums[2*g]/sizes[g];centers[2*g+1]=sums[2*g+1]/sizes[g];}
    if(!changed)break;
  }
  const quality=silhouette(points,labels,sizes,targetOrder,referenceOrder);
  return {labels,centers,sizes,silhouette:quality.score,approximate:quality.approximate};
}

export function analyzeAccumulated(acc:AnalysisAccumulator):{analysis:Analysis;sessionIds:string[]} {
  const base:Analysis={status:"collecting",message:"回答が集まると、意見の傾向と共通点が見えてきます。",eligible:0,minimum:8,points:[],groups:[],bridges:[]};
  const result=(analysis:Analysis,sessionIds:string[]=[])=>({analysis,sessionIds});
  const rows=acc.sessionIds.map((_,i)=>i).filter(i=>acc.substantive[i]>=6).sort((a,b)=>acc.sessionIds[a]<acc.sessionIds[b]?-1:acc.sessionIds[a]>acc.sessionIds[b]?1:0);
  const n=rows.length,width=acc.opinionIds.length;base.eligible=n;if(n<8)return result(base);
  const counts=new Uint32Array(width),sums=new Float64Array(width);
  for(const row of rows)for(let j=0;j<width;j++){const v=acc.value(row,j);if(v!==MISSING){counts[j]++;sums[j]+=v;}}
  const columns=Array.from({length:width},(_,j)=>j).filter(j=>counts[j]>=3),m=columns.length;
  if(m<6)return result({...base,message:"同じ意見への回答がまだ少ないため、グループ分けを保留しています。"});
  if(!connected(acc,rows,columns))return result({...base,message:"回答した意見の重なりが足りないため、グループ分けを保留しています。"});
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
  const pc1=component(m,0,multiply),projected=new Float64Array(m),product=new Float64Array(m);
  const deflated:Multiply=(input,output)=>{
    const amount=dot(input,pc1);for(let j=0;j<m;j++)projected[j]=input[j]-amount*pc1[j];
    multiply(projected,output);const remove=dot(output,pc1);for(let j=0;j<m;j++)output[j]-=remove*pc1[j];
  };
  const pc2=component(m,1,deflated);
  multiply(pc1,product);const first=dot(pc1,product);multiply(pc2,product);const explained=(first+dot(pc2,product))/total;
  const points=new Float64Array(n*2);
  for(let i=0;i<n;i++){
    let x=0,y=0;for(let j=0;j<m;j++){const v=acc.value(rows[i],columns[j]);if(v===MISSING)continue;const centered=v-means[j];x+=centered*pc1[j];y+=centered*pc2[j];}
    const scale=Math.sqrt(m/Math.max(observedCount[i],1));points[2*i]=x*scale;points[2*i+1]=y*scale;
  }
  const sessionIds=rows.map(row=>acc.sessionIds[row]),targetOrder=sampleOrder(sessionIds,0x6a09e667),referenceOrder=sampleOrder(sessionIds,0xbb67ae85);
  let best:Cluster|null=null;
  for(let k=2;k<=Math.min(4,Math.floor(n/3));k++)for(let start=0;start<Math.min(4,n);start++){
    const candidate=cluster(points,k,targetOrder[Math.floor(start*n/Math.min(4,n))],targetOrder,referenceOrder);
    if(candidate&&(!best||candidate.silhouette>best.silhouette))best=candidate;
  }
  if(!best||best.silhouette<.2)return result({...base,status:"unclear",message:"はっきりした意見群はまだ見つかっていません。回答を重ねて確認します。"});
  const k=best.sizes.length,order=Array.from({length:k},(_,g)=>g).sort((a,b)=>best!.centers[2*a]-best!.centers[2*b]||best!.centers[2*a+1]-best!.centers[2*b+1]),remap=new Uint8Array(k);
  order.forEach((old,g)=>remap[old]=g);const labels=best.labels;for(let i=0;i<n;i++)labels[i]=remap[labels[i]];
  const groups=order.map((old,id)=>({id,size:best!.sizes[old]})),seen=new Uint32Array(k*width),agree=new Uint32Array(k*width);
  for(let i=0;i<n;i++)for(let j=0;j<width;j++){const v=acc.value(rows[i],j);if(v===MISSING)continue;const index=labels[i]*width+j;seen[index]++;if(v===-1)agree[index]++;}
  const bridges=acc.opinionIds.map((id,j)=>{const counts=groups.map(g=>{const index=g.id*width+j;return {id:g.id,agree:agree[index],seen:seen[index],rate:seen[index]?agree[index]/seen[index]:0};});return {id,score:consensus(counts),groups:counts};}).filter(b=>b.groups.every(g=>g.seen>=3&&g.rate>=.6)).sort((a,b)=>b.score-a.score);
  return result({...base,status:"ready",message:"回答傾向が似たセッションをまとめています。",points:Array.from({length:n},(_,i)=>({x:points[2*i],y:points[2*i+1],group:labels[i],mine:false})),groups,bridges,explained,silhouette:best.silhouette,silhouetteApproximate:best.approximate,silhouetteMethod:best.approximate?"deterministic-stratified-256-targets-128-references-per-group":"exact"},sessionIds);
}

/** Compatibility wrapper. Shared cached analysis remains independent of mine. */
export function analyze(votes:Vote[],opinionIds:string[],mine?:string):Analysis {
  const {analysis,sessionIds}=analyzeAccumulated(new AnalysisAccumulator(opinionIds).add(votes));
  if(mine){const index=sessionIds.indexOf(mine);if(index>=0)analysis.points=analysis.points.map((point,i)=>i===index?{...point,mine:true}:point);}
  return analysis;
}
