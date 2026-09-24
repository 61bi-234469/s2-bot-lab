// Browser-safe entry hooks. Node installs a request-local provider once.
let provider=()=>null;
export function installStrategicAuditProvider(next){provider=next;}
export function noteStrategicCall(key){const audit=provider();if(audit!==null)audit[key]++;}
export function emptyStrategicAudit(){return {externalStrategicReselectCalls:0,legacyF14SelectionCalls:0,legacyF14RescueCalls:0};}
export function assertStrategicBoundary(audit){
  const keys=Object.keys(emptyStrategicAudit());
  if(!audit||Object.keys(audit).sort().join()!==keys.sort().join()||keys.some(k=>audit[k]!==0))throw new Error('integrated strategic boundary violation');
}
