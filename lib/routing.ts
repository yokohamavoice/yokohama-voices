export const ROUTING_VERSION = "tag-mixture-v2";
export type RoutingCandidate = {id:string;tagId:string;agree:number;disagree:number;pass:number;unrelated:number};
export function distribution(candidates:RoutingCandidate[], issuedByTag:Record<string,number>) {
  const tags=[...new Set(candidates.map(c=>c.tagId))];
  const tagSum=tags.reduce((s,t)=>s+1/(1+(issuedByTag[t]||0))**2,0);
  return tags.flatMap(tag=>{
    const items=candidates.filter(c=>c.tagId===tag);
    const q=.2/tags.length+.8/(1+(issuedByTag[tag]||0))**2/tagSum;
    const weights=items.map(c=>{const n=c.agree+c.disagree,p=(c.agree+1)/(n+2);return {disagreement:4*p*(1-p)*n/(n+8),underAnswered:1/Math.sqrt(1+n+c.pass+c.unrelated)};});
    const sumD=weights.reduce((s,w)=>s+w.disagreement,0),sumU=weights.reduce((s,w)=>s+w.underAnswered,0);
    return items.map((c,i)=>({id:c.id,probability:q*(.3/items.length+.4*(sumD?weights[i].disagreement/sumD:1/items.length)+.3*weights[i].underAnswered/sumU)}));
  });
}
export function draw(probabilities:ReturnType<typeof distribution>, random:number){
  if(!probabilities.length)return null;
  let cumulative=0;for(const row of probabilities){cumulative+=row.probability;if(random<cumulative)return row;}
  return probabilities[probabilities.length-1];
}
