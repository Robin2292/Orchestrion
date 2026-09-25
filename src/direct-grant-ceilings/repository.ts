import { LocalIdSchema, type LocalContext } from "../shared/local-contracts";
import { grantCanonicalJson, loadToolGrants, type ToolGrant, type ToolGrantSet } from "../shared/tool-grant-contracts";
import { ProjectRepository, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { grantDigest, grantSetDigest } from "../grants/repository";

export type CeilingSubject = "organization" | "agent";
export interface CeilingEvent {
  event_id: string; revision: number; action: "grant" | "revoke";
  grant_json: string | null; tuple_hash: string | null;
  parent_org_version_id: string | null; revoked_version_id: string | null;
  request_hash: string;
}
export interface LiveCeilingGrant { versionId: string; grant: ToolGrant; parentOrganizationVersionId: string | null }
export interface DirectGrantCeilings {
  agentPrincipalId: string;
  organizationRevision: number; principalRevision: number;
  organizationHash: string; principalHash: string;
  organization: readonly LiveCeilingGrant[]; principal: readonly LiveCeilingGrant[];
}

const empty = (): ToolGrantSet => ({ schema_version: "tool_grants@1", grants: [] });

/** A scoped event repository; D2E3 can reuse resolveForAssignment in its own fence. */
export class LocalDirectGrantCeilingRepository {
  constructor(private readonly tx: SqliteUnit, private readonly context: LocalContext) {
    new ProjectRepository(tx, context);
  }
  assertHumanGrantor(): void {
    const c = this.context;
    if (c.principal.type !== "user" || !this.tx.get(`SELECT 1 FROM memberships
      WHERE org_id=? AND principal_type='user' AND principal_id=? AND role IN ('owner','admin')`,
    c.org_id, c.principal.id)) throw new StorageError("DIRECT_GRANT_GRANTOR_DENIED");
  }
  assertLiveAgent(agentPrincipalId: string): void {
    const c = this.context;
    if (!this.tx.get(`SELECT 1 FROM agent_identities a JOIN local_agents l
      ON l.org_id=a.org_id AND l.project_id=a.home_project_id
        AND l.principal_type=a.owner_principal_type AND l.principal_id=a.owner_principal_id
        AND l.id=a.id AND l.node_type='agent'
      WHERE a.org_id=? AND a.id=? AND a.agent_principal_id=a.id
        AND a.identity_state='governed' AND a.removed_at IS NULL AND l.deleted_at IS NULL`,
    c.org_id, LocalIdSchema.parse(agentPrincipalId)))
      throw new StorageError("DIRECT_GRANT_AGENT_PRINCIPAL_UNAVAILABLE");
  }
  latest(subjectKind: CeilingSubject, subjectId: string): CeilingEvent | null {
    return (this.tx.get(`SELECT event_id,revision,action,grant_json,tuple_hash,
      parent_org_version_id,revoked_version_id,request_hash FROM local_direct_grant_ceiling_events
      WHERE org_id=? AND subject_kind=? AND subject_id=? ORDER BY revision DESC LIMIT 1`,
    this.context.org_id,subjectKind,subjectId) as unknown as CeilingEvent | undefined) ?? null;
  }
  replay(subjectKind: CeilingSubject, subjectId: string, idempotencyKey: string): CeilingEvent | null {
    const row=this.tx.get(`SELECT event_id,revision,action,grant_json,tuple_hash,
      parent_org_version_id,revoked_version_id,request_hash FROM local_direct_grant_ceiling_events
      WHERE org_id=? AND subject_kind=? AND subject_id=? AND grantor_id=? AND idempotency_key=?`,
    this.context.org_id,subjectKind,subjectId,this.context.principal.id,idempotencyKey);
    return (row as unknown as CeilingEvent | undefined) ?? null;
  }
  active(subjectKind: CeilingSubject, subjectId: string): LiveCeilingGrant[] {
    const rows = this.tx.all(`SELECT g.event_id,g.grant_json,g.parent_org_version_id
      FROM local_direct_grant_ceiling_events g
      WHERE g.org_id=? AND g.subject_kind=? AND g.subject_id=? AND g.action='grant'
        AND NOT EXISTS (SELECT 1 FROM local_direct_grant_ceiling_events r
          WHERE r.org_id=g.org_id AND r.action='revoke' AND r.revoked_version_id=g.event_id)
      ORDER BY g.revision`,this.context.org_id,subjectKind,subjectId);
    return rows.map(row => ({versionId:String(row.event_id),
      grant:loadToolGrants(grantCanonicalJson({schema_version:"tool_grants@1",grants:[JSON.parse(String(row.grant_json))]})).grants[0],
      parentOrganizationVersionId:row.parent_org_version_id===null ? null : String(row.parent_org_version_id)}));
  }
  append(subjectKind: CeilingSubject,subjectId: string,eventId: string,revision: number,
    action: "grant"|"revoke",grant: ToolGrant|null,parentOrganizationVersionId: string|null,
    revokedVersionId: string|null,idempotencyKey: string,requestHash: string,now: string): void {
    const c=this.context;
    this.tx.run(`INSERT INTO local_direct_grant_ceiling_events
      (event_id,org_id,subject_kind,subject_id,revision,action,grant_json,tuple_hash,
       parent_org_version_id,revoked_version_id,grantor_type,grantor_id,idempotency_key,request_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'user',?,?,?,?)`,
    eventId,c.org_id,subjectKind,subjectId,revision,action,
    grant===null ? null : grantCanonicalJson(grant),
    grant===null ? null : grantDigest(grant),
    parentOrganizationVersionId,revokedVersionId,c.principal.id,idempotencyKey,requestHash,now);
  }
  /** The live Assignment source, including organization-visible cross-Project identities. */
  resolveForAssignment(assignmentId: string, projectId: string): DirectGrantCeilings {
    const c=this.context;
    if (projectId!==c.project_id) throw new StorageError("DIRECT_GRANT_PROJECT_SCOPE_DENIED");
    const rows=this.tx.all(`SELECT a.agent_principal_id FROM project_agent_assignments x
      JOIN agent_identities a ON a.org_id=x.org_id AND a.id=x.agent_id
      JOIN local_agents l ON l.org_id=a.org_id AND l.project_id=a.home_project_id
        AND l.principal_type=a.owner_principal_type AND l.principal_id=a.owner_principal_id
        AND l.id=a.id AND l.node_type='agent'
      WHERE x.org_id=? AND x.project_id=? AND x.id=? AND x.status='active'
        AND x.migration_state='governed' AND a.identity_state='governed'
        AND a.agent_principal_id=a.id AND a.removed_at IS NULL AND l.deleted_at IS NULL
        AND (a.visibility='organization' OR a.home_project_id=x.project_id)`,
    c.org_id,LocalIdSchema.parse(projectId),LocalIdSchema.parse(assignmentId));
    if (rows.length!==1) throw new StorageError("DIRECT_GRANT_AGENT_PRINCIPAL_UNAVAILABLE");
    const agentPrincipalId=String(rows[0].agent_principal_id);
    const orgRevision=this.latest("organization",c.org_id)?.revision;
    const principalRevision=this.latest("agent",agentPrincipalId)?.revision;
    if (!orgRevision || !principalRevision) throw new StorageError("DIRECT_GRANT_CEILING_REQUIRED");
    const organization=this.active("organization",c.org_id);
    const activeOrgIds=new Set(organization.map(g=>g.versionId));
    const principal=this.active("agent",agentPrincipalId);
    if (principal.some(g=>g.parentOrganizationVersionId===null
      || !activeOrgIds.has(g.parentOrganizationVersionId)))
      throw new StorageError("DIRECT_GRANT_ANCESTRY_STALE");
    if (!organization.length || !principal.length) throw new StorageError("DIRECT_GRANT_CEILING_REQUIRED");
    return {agentPrincipalId,organizationRevision:orgRevision,principalRevision,
      organizationHash:grantSetDigest({...empty(),grants:organization.map(g=>g.grant)}),
      principalHash:grantSetDigest({...empty(),grants:principal.map(g=>g.grant)}),
      organization,principal};
  }
}
