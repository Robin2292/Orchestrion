import { LocalAssignmentRepository } from "../assignments/repository";
import { LocalBudgetCeilingRepository } from "../budgets/repository";
import { ProjectAgentAssignmentVersionSchema } from "../shared/agent-session-contracts";
import type { LocalContext } from "../shared/local-contracts";
import { StorageError, type SqliteUnit } from "../storage/sqlite/foundation";

export interface DirectSessionRow {
  org_id:string; id:string; project_id:string; agent_id:string; provenance:string;
  lifecycle:string; agent_version_id:string|null; assignment_id:string|null;
  assignment_version_id:string|null; resolved_config_hash:string|null;
  archived_at:string|null; created_at:string; title:string; deleted_at:string|null;
  deletion_state:"ready"|"pending";
}
export interface DirectAttemptRow {
  id:string; session_id:string; attempt_number:number; outcome:string;
  runtime_owner_json:string; workspace_binding_id:string; source_revision_or_snapshot:string;
  execution_placement_binding_id:string; fencing_token:string;
  effective_authority_hash:string; resolved_config_hash:string;
  provider_execution_ref:string|null;
}

/** Every query is tenant and Project scoped; the service owns policy decisions. */
export class DirectSessionRepository {
  private readonly assignments: LocalAssignmentRepository;
  constructor(private readonly tx:SqliteUnit, readonly context:LocalContext) {
    this.assignments=new LocalAssignmentRepository(tx,context);
    this.assignments.authorize();
  }
  authorizeWrite(): void { this.assignments.authorize(true); }
  session(id:string): DirectSessionRow|null {
    const c=this.context;
    const row=this.tx.get(`SELECT s.*,d.title,d.deleted_at,d.deletion_state FROM agent_sessions s
      JOIN direct_session_state d ON d.org_id=s.org_id AND d.session_id=s.id AND d.project_id=s.project_id
      WHERE s.org_id=? AND s.project_id=? AND s.id=? AND s.source='direct'`,c.org_id,c.project_id,id);
    return row ? row as unknown as DirectSessionRow : null;
  }
  list(limit:number,offset:number):DirectSessionRow[] {
    const c=this.context;
    return this.tx.all(`SELECT s.*,d.title,d.deleted_at,d.deletion_state FROM agent_sessions s
      JOIN direct_session_state d ON d.org_id=s.org_id AND d.session_id=s.id AND d.project_id=s.project_id
      WHERE s.org_id=? AND s.project_id=? AND s.source='direct' AND s.provenance='released'
      AND d.deleted_at IS NULL ORDER BY s.created_at DESC,s.id DESC LIMIT ? OFFSET ?`,
      c.org_id,c.project_id,limit,offset) as unknown as DirectSessionRow[];
  }
  attempt(sessionId:string,id:string):DirectAttemptRow|null {
    const c=this.context;
    const row=this.tx.get(`SELECT a.* FROM agent_session_attempts a JOIN agent_sessions s
      ON s.org_id=a.org_id AND s.id=a.session_id WHERE a.org_id=? AND s.project_id=?
      AND a.session_id=? AND a.id=?`,c.org_id,c.project_id,sessionId,id);
    return row ? row as unknown as DirectAttemptRow : null;
  }
  latestAttempt(sessionId:string):DirectAttemptRow|null {
    const c=this.context;
    const row=this.tx.get(`SELECT a.* FROM agent_session_attempts a JOIN agent_sessions s
      ON s.org_id=a.org_id AND s.id=a.session_id WHERE a.org_id=? AND s.project_id=?
      AND a.session_id=? ORDER BY a.attempt_number DESC LIMIT 1`,c.org_id,c.project_id,sessionId);
    return row ? row as unknown as DirectAttemptRow : null;
  }
  workspaceBindingUsed(workspaceId:string):boolean {
    const c=this.context;
    return !!this.tx.get(`SELECT 1 FROM agent_session_attempts a JOIN agent_sessions s
      ON s.org_id=a.org_id AND s.id=a.session_id WHERE a.org_id=? AND s.project_id=?
      AND a.workspace_binding_id=? LIMIT 1`,c.org_id,c.project_id,workspaceId);
  }
  /** Resolve the exact released version and live principal in one transaction. */
  released(assignmentId:string,versionId?:string) {
    const a=this.assignments.assignment(assignmentId);
    if (!a || a.status!=="active" || a.migration_state!=="governed" || !a.current_assignment_version_id)
      throw new StorageError("DIRECT_ASSIGNMENT_UNAVAILABLE");
    const identity=this.assignments.identity(a.agent_id);
    if (!identity || identity.identity_state!=="governed" || identity.removed_at!==null
      || identity.agent_principal_id!==identity.id
      || (identity.visibility!=="organization" && identity.home_project_id!==a.project_id))
      throw new StorageError("DIRECT_PRINCIPAL_UNAVAILABLE");
    const row=this.tx.get(`SELECT v.* FROM project_agent_assignment_versions v
      WHERE v.org_id=? AND v.project_id=? AND v.assignment_id=? AND v.id=? AND v.agent_id=?`,
      this.context.org_id,this.context.project_id,a.id,versionId??a.current_assignment_version_id,a.agent_id);
    if (!row) throw new StorageError("DIRECT_VERSION_UNAVAILABLE");
    const contract=ProjectAgentAssignmentVersionSchema.parse(JSON.parse(String(row.contract_json)));
    if (contract.orgId!==this.context.org_id || contract.assignmentId!==a.id
      || contract.id!==row.id || contract.agentVersionId!==row.agent_version_id
      || contract.resolvedConfigHash!==row.resolved_config_hash
      || contract.memoryScopeHash!==row.memory_scope_hash
      || contract.authorityCeilingHash!==row.authority_ceiling_hash)
      throw new StorageError("DIRECT_VERSION_UNAVAILABLE");
    const source=this.assignments.sourceVersion(identity,contract.agentVersionId);
    if (!source || JSON.parse(source.definition_json).nodeType!=="agent")
      throw new StorageError("DIRECT_VERSION_UNAVAILABLE");
    let budget;
    try {
      budget=new LocalBudgetCeilingRepository(this.tx,this.context)
        .resolveForAssignment(a.id,a.project_id);
    } catch(error) {
      if (error instanceof StorageError && ["BUDGET_CEILING_REQUIRED","BUDGET_AGENT_PRINCIPAL_UNAVAILABLE",
        "BUDGET_PROJECT_SCOPE_DENIED"].includes(error.code)) throw new StorageError("DIRECT_BUDGET_REVOKED");
      throw error;
    }
    return {assignment:a,identity,contract,budget,source};
  }
  insert(id:string, facts:ReturnType<DirectSessionRepository["released"]>, title:string, now:string):void {
    const c=this.context,{assignment,identity,contract}=facts;
    this.tx.run(`INSERT INTO agent_sessions(org_id,id,project_id,agent_id,source,lifecycle,provenance,
      agent_version_id,assignment_id,assignment_version_id,resolved_config_hash,agent_principal_json,
      initiated_by_json,materialized_by_json,memory_scope_json,created_at)
      VALUES (?,?,?,?,'direct','active','released',?,?,?,?,?,?,?,?,?)`,
      c.org_id,id,c.project_id,identity.id,contract.agentVersionId,assignment.id,contract.id,
      contract.resolvedConfigHash,JSON.stringify({type:"agent",id:identity.id}),
      JSON.stringify({type:"human",id:c.principal.id}),JSON.stringify({type:"system",id:"local-runtime"}),
      JSON.stringify({type:"direct",projectId:c.project_id,sessionId:id,sharing:"session_only"}),now);
    this.tx.run(`INSERT INTO direct_session_state(org_id,session_id,project_id,title,updated_at)
      VALUES (?,?,?,?,?)`,c.org_id,id,c.project_id,title,now);
  }
  rename(id:string,title:string,now:string):void {
    const c=this.context;
    const changed=this.tx.run(`UPDATE direct_session_state SET title=?,updated_at=?
      WHERE org_id=? AND project_id=? AND session_id=? AND deleted_at IS NULL`,
      title,now,c.org_id,c.project_id,id);
    if (changed.changes!==1) throw new StorageError("DIRECT_SESSION_UNAVAILABLE");
  }
  lifecycle(id:string,from:"active"|"archived",to:"active"|"archived",now:string):void {
    const c=this.context;
    if (!this.session(id) || this.session(id)!.deleted_at!==null) throw new StorageError("DIRECT_SESSION_UNAVAILABLE");
    const changed=this.tx.run(`UPDATE agent_sessions SET lifecycle=?,archived_at=?
      WHERE org_id=? AND project_id=? AND id=? AND source='direct' AND lifecycle=?`,
      to,to==="archived"?now:null,c.org_id,c.project_id,id,from);
    if (changed.changes!==1) throw new StorageError("DIRECT_SESSION_STATE_CONFLICT");
  }
  tombstone(id:string,now:string):void {
    const c=this.context;
    const changed=this.tx.run(`UPDATE direct_session_state SET deleted_at=?,updated_at=?
      WHERE org_id=? AND project_id=? AND session_id=? AND deleted_at IS NULL AND deletion_state='pending'`,
      now,now,c.org_id,c.project_id,id);
    if (changed.changes!==1) throw new StorageError("DIRECT_SESSION_UNAVAILABLE");
  }
  reserveDelete(id:string,now:string):void {
    const c=this.context;
    const changed=this.tx.run(`UPDATE direct_session_state SET deletion_state='pending',updated_at=?
      WHERE org_id=? AND project_id=? AND session_id=? AND deleted_at IS NULL AND deletion_state='ready'`,
      now,c.org_id,c.project_id,id);
    if (changed.changes!==1) throw new StorageError("DIRECT_SESSION_STATE_CONFLICT");
  }
  providerCleanupAttempts(id:string):DirectAttemptRow[] {
    const c=this.context;
    return this.tx.all(`SELECT a.* FROM agent_session_attempts a
      JOIN agent_sessions s ON s.org_id=a.org_id AND s.id=a.session_id
      WHERE a.org_id=? AND s.project_id=? AND a.session_id=? AND a.provider_execution_ref IS NOT NULL
      ORDER BY a.attempt_number,a.id`,c.org_id,c.project_id,id) as unknown as DirectAttemptRow[];
  }
  insertAttempt(input:{id:string;sessionId:string;number:number;placementId:string;workspaceId:string;
    sourceRevision:string;ownerJson:string;fence:string;authorityHash:string;configHash:string;
    accountingId:string;providerRef:string|null;now:string}):void {
    const c=this.context;
    this.tx.run(`INSERT INTO agent_session_attempts(org_id,id,session_id,attempt_number,
      execution_placement_binding_id,workspace_binding_id,source_revision_or_snapshot,
      runtime_owner_json,fencing_token,effective_authority_hash,resolved_config_hash,
      accounting_identity,provider_execution_ref,fallback,outcome,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'forbidden','running',?)`,c.org_id,input.id,input.sessionId,
      input.number,input.placementId,input.workspaceId,input.sourceRevision,input.ownerJson,
      input.fence,input.authorityHash,input.configHash,input.accountingId,input.providerRef,input.now);
  }
  outcome(sessionId:string,attemptId:string,from:string,to:string):void {
    const c=this.context;
    const changed=this.tx.run(`UPDATE agent_session_attempts SET outcome=? WHERE org_id=? AND session_id=?
      AND id=? AND outcome=?`,to,c.org_id,sessionId,attemptId,from);
    if (changed.changes!==1) throw new StorageError("DIRECT_ATTEMPT_STATE_CONFLICT");
  }
}
