export const ANALYSIS_ALGORITHM="polis-math-v4-daily-warm-projection";

/** A snapshot is reusable only with the complete configuration that produced it.
 * Compare keys explicitly so JSON key order does not invalidate a good snapshot. */
export function matchesAnalysisConfiguration(
 snapshot:{algorithm?:unknown;parameters?:unknown}|null|undefined,
 parameters:Readonly<Record<string,number>>,
):boolean {
 if(snapshot?.algorithm!==ANALYSIS_ALGORITHM)return false;
 const stored=snapshot.parameters;
 if(!stored||typeof stored!=="object"||Array.isArray(stored))return false;
 const keys=Object.keys(parameters),values=stored as Record<string,unknown>;
 return Object.keys(values).length===keys.length&&keys.every(key=>
  Object.prototype.hasOwnProperty.call(values,key)&&values[key]===parameters[key]
 );
}
