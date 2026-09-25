/** The only provider-call metadata permitted to cross the utility boundary. */
const failures = ["MODEL_NOT_READY", "PROVIDER_AUTH_EXPIRED", "PROVIDER_RATE_LIMIT",
  "PROVIDER_QUOTA", "PROVIDER_BAD_REQUEST", "PROVIDER_NETWORK", "PROVIDER_TIMEOUT",
  "PROVIDER_PROTOCOL_ERROR", "PROVIDER_INCOMPLETE", "PROVIDER_STREAM_LIMIT",
  "PROVIDER_PROBE_USED", "PROVIDER_UNAVAILABLE"] as const;
const stages = ["redirect", "body_missing", "content_type", "event_json", "event_shape",
  "tool_output", "stream_decode"] as const;
export type CodexTextFailure = typeof failures[number];
export type CodexProtocolStage = typeof stages[number];
export type CodexTextDiagnostic = {kind:"transport_completed"} | {kind:"failure";
  code:CodexTextFailure;stage:CodexProtocolStage|null};

export function parseCodexTextDiagnostic(raw:unknown):CodexTextDiagnostic|null {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const value=raw as Record<string,unknown>,keys=Reflect.ownKeys(value);
  if(value.kind==="transport_completed"&&keys.length===1&&keys[0]==="kind")
    return {kind:"transport_completed"};
  if(value.kind!=="failure"||keys.length!==3
    ||!keys.includes("kind")||!keys.includes("code")||!keys.includes("stage")
    ||!failures.includes(value.code as CodexTextFailure)
    ||value.stage!==null&&!stages.includes(value.stage as CodexProtocolStage))return null;
  return {kind:"failure",code:value.code as CodexTextFailure,
    stage:value.stage as CodexProtocolStage|null};
}

/** Telemetry must never change the result of a physical provider call. */
export function reportCodexTextDiagnostic(send:(message:unknown)=>void,
  diagnostic:CodexTextDiagnostic):void {
  const safe=parseCodexTextDiagnostic(diagnostic);
  if(!safe)return;
  try {send({type:"codex-text-diagnostic",diagnostic:safe});}
  catch { /* best effort only */ }
}
