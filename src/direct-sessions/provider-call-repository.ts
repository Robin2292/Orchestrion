import type { SqliteUnit } from "../storage/sqlite/foundation";

export interface DirectProviderCallRow {
  org_id:string;id:string;session_id:string;attempt_id:string;agent_id:string;
  agent_version_id:string;assignment_version_id:string;authority_hash:string;config_hash:string;
  placement_id:string;workspace_id:string;source_revision:string;fencing_token:string;
  logical_slot:string;physical_index:number;request_digest:string;digest_version:string;
  model_id:string;pricing_json:string;reserved_tokens:number;reserved_microusd:number;
  actual_tokens:number|null;actual_microusd:number|null;would_have_microusd:number|null;
  lifecycle:"reserved"|"started"|"settled"|"unknown"|"released";
  result_state:"none"|"replayable"|"applied";dispatch_token_hash:string|null;
  capsule_json:string|null;capsule_hash:string|null;decision_hash:string|null;continuation_json:string|null;
}

/** SQL only. The Direct service owns admission; the ledger service owns decisions. */
export class DirectProviderCallRepository {
  constructor(private readonly tx:SqliteUnit,private readonly orgId:string) {}
  key():{id:string;checkHash:string}|null {
    const row=this.tx.get("SELECT key_id,key_check_hash FROM direct_provider_capsule_keys WHERE org_id=?",this.orgId);
    return row?{id:String(row.key_id),checkHash:String(row.key_check_hash)}:null;
  }
  insertKey(id:string,checkHash:string):void {
    this.tx.run("INSERT INTO direct_provider_capsule_keys(org_id,key_id,key_check_hash) VALUES (?,?,?)",
      this.orgId,id,checkHash);
  }
  slot(attemptId:string,slot:string,index:number):DirectProviderCallRow|null {
    const row=this.tx.get(`SELECT * FROM direct_provider_calls WHERE org_id=? AND attempt_id=?
      AND logical_slot=? AND physical_index=?`,this.orgId,attemptId,slot,index);
    return (row as unknown as DirectProviderCallRow | undefined) ?? null;
  }
  latest(attemptId:string,slot:string):DirectProviderCallRow|null {
    const row=this.tx.get(`SELECT * FROM direct_provider_calls WHERE org_id=? AND attempt_id=?
      AND logical_slot=? ORDER BY physical_index DESC LIMIT 1`,this.orgId,attemptId,slot);
    return (row as unknown as DirectProviderCallRow | undefined) ?? null;
  }
  id(id:string):DirectProviderCallRow|null {
    const row=this.tx.get("SELECT * FROM direct_provider_calls WHERE org_id=? AND id=?",this.orgId,id);
    return (row as unknown as DirectProviderCallRow | undefined) ?? null;
  }
  /** Reserved/started/UNKNOWN consume their full hold; settled consumes actual. */
  spend(scope:"org"|"agent"|"session",id:string):{tokens:number;microusd:number} {
    const filter=scope==="org"?"org_id=?":scope==="agent"?"org_id=? AND agent_id=?":"org_id=? AND session_id=?";
    const args=scope==="org"?[this.orgId]:[this.orgId,id];
    const row=this.tx.get(`SELECT COALESCE(SUM(CASE WHEN lifecycle='settled' THEN actual_tokens
      WHEN lifecycle='released' THEN 0 ELSE reserved_tokens END),0) AS tokens,
      COALESCE(SUM(CASE WHEN lifecycle='settled' THEN actual_microusd
      WHEN lifecycle='released' THEN 0 ELSE reserved_microusd END),0) AS microusd
      FROM direct_provider_calls WHERE ${filter}`,...args)!;
    return {tokens:Number(row.tokens),microusd:Number(row.microusd)};
  }
  insert(row:DirectProviderCallRow,now:string):void {
    this.tx.run(`INSERT INTO direct_provider_calls(org_id,id,session_id,attempt_id,agent_id,
      agent_version_id,assignment_version_id,authority_hash,config_hash,placement_id,workspace_id,
      source_revision,fencing_token,logical_slot,physical_index,request_digest,digest_version,
      model_id,pricing_json,reserved_tokens,reserved_microusd,lifecycle,result_state,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved','none',?)`,
      row.org_id,row.id,row.session_id,row.attempt_id,row.agent_id,row.agent_version_id,
      row.assignment_version_id,row.authority_hash,row.config_hash,row.placement_id,row.workspace_id,
      row.source_revision,row.fencing_token,row.logical_slot,row.physical_index,row.request_digest,
      row.digest_version,row.model_id,row.pricing_json,row.reserved_tokens,row.reserved_microusd,now);
  }
  claim(id:string,tokenHash:string,now:string):boolean {
    return this.tx.run(`UPDATE direct_provider_calls SET lifecycle='started',started_at=?,dispatch_token_hash=?
      WHERE org_id=? AND id=? AND lifecycle='reserved'`,now,tokenHash,this.orgId,id).changes===1;
  }
  release(id:string):boolean {
    return this.tx.run(`UPDATE direct_provider_calls SET lifecycle='released' WHERE org_id=?
      AND id=? AND lifecycle='reserved'`,this.orgId,id).changes===1;
  }
  unknown(id:string,tokenHash:string,now:string):boolean {
    return this.tx.run(`UPDATE direct_provider_calls SET lifecycle='unknown',unknown_at=? WHERE org_id=?
      AND id=? AND lifecycle='started' AND dispatch_token_hash=?`,now,this.orgId,id,tokenHash).changes===1;
  }
  settle(id:string,tokenHash:string,usageTokens:number,cost:number,wouldHave:number,
    capsule:string,capsuleHash:string,now:string):boolean {
    return this.tx.run(`UPDATE direct_provider_calls SET lifecycle='settled',result_state='replayable',
      actual_tokens=?,actual_microusd=?,would_have_microusd=?,capsule_json=?,capsule_hash=?,settled_at=?
      WHERE org_id=? AND id=? AND lifecycle='started' AND dispatch_token_hash=?`,
      usageTokens,cost,wouldHave,capsule,capsuleHash,now,this.orgId,id,tokenHash).changes===1;
  }
  apply(id:string,decisionHash:string,continuation:string,now:string):boolean {
    return this.tx.run(`UPDATE direct_provider_calls SET result_state='applied',decision_hash=?,
      continuation_json=?,applied_at=?
      WHERE org_id=? AND id=? AND lifecycle='settled' AND result_state='replayable'`,
      decisionHash,continuation,now,this.orgId,id).changes===1;
  }
  finishAttempt(sessionId:string,attemptId:string):boolean {
    return this.tx.run(`UPDATE agent_session_attempts SET outcome='completed' WHERE org_id=?
      AND session_id=? AND id=? AND outcome IN ('running','waiting')`,
      this.orgId,sessionId,attemptId).changes===1;
  }
}
