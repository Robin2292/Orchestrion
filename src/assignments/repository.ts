import { randomUUID } from "node:crypto";
import { LocalContextSchema, type LocalContext } from "../shared/local-contracts";
import { ProjectRepository, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";

export interface IdentityRow {
  org_id: string; id: string; name: string; visibility: string; home_project_id: string;
  derived_from_agent_version_id: string | null; agent_principal_id: string | null;
  identity_state: string; owner_principal_type: string; owner_principal_id: string;
  created_at: string; removed_at: string | null;
}
export interface AssignmentRow {
  org_id: string; id: string; project_id: string; agent_id: string;
  status: string; current_assignment_version_id: string | null;
  migration_state: string; created_at: string; removed_at: string | null;
}
export interface CatalogRow extends IdentityRow {
  latest_version_id: string; latest_version_number: number;
  assignment_status: string | null;
}
export interface CatalogVersionRow {
  id: string; version_number: number; definition_json: string; created_at: string;
  soul_content: string | null; soul_hash: string | null;
}

/** All organization reads are membership-scoped; every Project read also checks project_id. */
export class LocalAssignmentRepository {
  readonly context: LocalContext;
  constructor(private readonly tx: SqliteUnit, context: LocalContext) {
    this.context = LocalContextSchema.parse(context);
    new ProjectRepository(tx, this.context);
  }
  authorize(write = false, admin = false): void {
    const c = this.context;
    const row = this.tx.get("SELECT role FROM memberships WHERE org_id=? AND principal_type=? AND principal_id=?",
      c.org_id, c.principal.type, c.principal.id);
    if (!row || (write && !["owner", "admin", "editor"].includes(String(row.role)))
      || (admin && !["owner", "admin"].includes(String(row.role)))) throw new StorageError("NOT_AUTHENTICATED");
  }
  canAdd(): boolean {
    const c=this.context;
    const row=this.tx.get("SELECT role FROM memberships WHERE org_id=? AND principal_type=? AND principal_id=?",
      c.org_id,c.principal.type,c.principal.id);
    return !!row && ["owner","admin","editor"].includes(String(row.role));
  }
  identity(id: string): IdentityRow | null {
    const c = this.context;
    return (this.tx.get("SELECT * FROM agent_identities WHERE org_id=? AND id=?", c.org_id, id) as unknown as IdentityRow | undefined) ?? null;
  }
  /** Read only governed, live, first-class Agents visible from this Project. */
  catalog(limit: number, offset: number): CatalogRow[] {
    const c=this.context;
    return this.tx.all(`SELECT i.*,v.id AS latest_version_id,v.version_number AS latest_version_number,
        pa.status AS assignment_status FROM agent_identities i
      JOIN local_agents a ON a.org_id=i.org_id AND a.project_id=i.home_project_id
        AND a.principal_type=i.owner_principal_type AND a.principal_id=i.owner_principal_id AND a.id=i.id
      JOIN local_agent_versions v ON v.org_id=a.org_id AND v.project_id=a.project_id
        AND v.principal_type=a.principal_type AND v.principal_id=a.principal_id
        AND v.agent_id=a.id AND v.id=a.latest_version_id
      LEFT JOIN project_agent_assignments pa ON pa.org_id=i.org_id AND pa.project_id=? AND pa.agent_id=i.id
      WHERE i.org_id=? AND i.identity_state='governed' AND i.agent_principal_id=i.id
        AND i.removed_at IS NULL AND a.deleted_at IS NULL AND a.node_type='agent'
        AND (i.visibility='organization' OR i.home_project_id=?)
      ORDER BY i.created_at,i.id LIMIT ? OFFSET ?`,c.project_id,c.org_id,c.project_id,limit,offset) as unknown as CatalogRow[];
  }
  catalogTotal(): number {
    const c=this.context;
    return Number(this.tx.get(`SELECT count(*) AS n FROM agent_identities i
      JOIN local_agents a ON a.org_id=i.org_id AND a.project_id=i.home_project_id
        AND a.principal_type=i.owner_principal_type AND a.principal_id=i.owner_principal_id AND a.id=i.id
      JOIN local_agent_versions v ON v.org_id=a.org_id AND v.project_id=a.project_id
        AND v.principal_type=a.principal_type AND v.principal_id=a.principal_id
        AND v.agent_id=a.id AND v.id=a.latest_version_id
      WHERE i.org_id=? AND i.identity_state='governed' AND i.agent_principal_id=i.id
        AND i.removed_at IS NULL AND a.deleted_at IS NULL AND a.node_type='agent'
        AND (i.visibility='organization' OR i.home_project_id=?)`,c.org_id,c.project_id)!.n);
  }
  catalogIdentity(id: string): CatalogRow | null {
    const c=this.context;
    const row=this.tx.get(`SELECT i.*,v.id AS latest_version_id,v.version_number AS latest_version_number,
        pa.status AS assignment_status FROM agent_identities i
      JOIN local_agents a ON a.org_id=i.org_id AND a.project_id=i.home_project_id
        AND a.principal_type=i.owner_principal_type AND a.principal_id=i.owner_principal_id AND a.id=i.id
      JOIN local_agent_versions v ON v.org_id=a.org_id AND v.project_id=a.project_id
        AND v.principal_type=a.principal_type AND v.principal_id=a.principal_id
        AND v.agent_id=a.id AND v.id=a.latest_version_id
      LEFT JOIN project_agent_assignments pa ON pa.org_id=i.org_id AND pa.project_id=? AND pa.agent_id=i.id
      WHERE i.org_id=? AND i.id=? AND i.identity_state='governed' AND i.agent_principal_id=i.id
        AND i.removed_at IS NULL AND a.deleted_at IS NULL AND a.node_type='agent'
        AND (i.visibility='organization' OR i.home_project_id=?)`,c.project_id,c.org_id,id,c.project_id);
    return row as unknown as CatalogRow | null;
  }
  catalogVersions(agent: CatalogRow,limit: number,offset: number): CatalogVersionRow[] {
    const c=this.context;
    return this.tx.all(`SELECT v.id,v.version_number,v.definition_json,v.created_at,
        s.content AS soul_content,s.content_hash AS soul_hash FROM local_agent_versions v
      LEFT JOIN local_agent_soul_snapshots s ON s.org_id=v.org_id AND s.project_id=v.project_id
        AND s.principal_type=v.principal_type AND s.principal_id=v.principal_id
        AND s.agent_id=v.agent_id AND s.version_id=v.id
      WHERE v.org_id=? AND v.project_id=? AND v.principal_type=? AND v.principal_id=? AND v.agent_id=?
      ORDER BY v.version_number DESC,v.id DESC LIMIT ? OFFSET ?`,c.org_id,agent.home_project_id,
      agent.owner_principal_type,agent.owner_principal_id,agent.id,limit,offset) as unknown as CatalogVersionRow[];
  }
  catalogVersionTotal(agent: CatalogRow): number {
    const c=this.context;
    return Number(this.tx.get(`SELECT count(*) AS n FROM local_agent_versions
      WHERE org_id=? AND project_id=? AND principal_type=? AND principal_id=? AND agent_id=?`,
      c.org_id,agent.home_project_id,agent.owner_principal_type,agent.owner_principal_id,agent.id)!.n);
  }
  insertIdentity(id: string, name: string, visibility: string, sourceVersionId: string | null, now: string): void {
    const c = this.context;
    this.tx.run(`INSERT INTO agent_identities
      (org_id,id,name,visibility,home_project_id,derived_from_agent_version_id,agent_principal_id,
       identity_state,owner_principal_type,owner_principal_id,created_at)
      VALUES (?,?,?,?,?,?,?,'governed',?,?,?)`, c.org_id,id,name,visibility,c.project_id,sourceVersionId,id,
      c.principal.type,c.principal.id,now);
  }
  /** The A0 authoring lane remains legacy-unversioned. Its first-class Agent
   * writes must nevertheless create the D2 membership projection atomically. */
  insertLegacyAgent(id: string, name: string, now: string): void {
    const c = this.context;
    this.tx.run(`INSERT INTO agent_identities
      (org_id,id,name,visibility,home_project_id,derived_from_agent_version_id,agent_principal_id,
       identity_state,owner_principal_type,owner_principal_id,created_at)
      VALUES (?,?,?,'project',?,NULL,NULL,'legacy_unresolved',?,?,?)`,
      c.org_id,id,name,c.project_id,c.principal.type,c.principal.id,now);
    this.tx.run(`INSERT INTO project_agent_assignments
      (org_id,id,project_id,agent_id,status,migration_state,created_at)
      VALUES (?,?,?,?,'active','legacy_unversioned',?)`,
      c.org_id,`assignment:${id}`,c.project_id,id,now);
  }
  syncLegacyName(id: string, name: string): void {
    const c = this.context;
    const changed = this.tx.run(`UPDATE agent_identities SET name=? WHERE org_id=? AND id=?
      AND home_project_id=? AND owner_principal_type=? AND owner_principal_id=?`,
      name,c.org_id,id,c.project_id,c.principal.type,c.principal.id);
    if (changed.changes !== 1) throw new StorageError("AGENT_IDENTITY_UNAVAILABLE");
  }
  retainLegacyRemoval(id: string, now: string): void {
    const c = this.context;
    const identity = this.identity(id);
    if (!identity || identity.home_project_id!==c.project_id
        || identity.identity_state!=="legacy_unresolved") throw new StorageError("AGENT_REFERENCED");
    const changed = this.tx.run(`UPDATE project_agent_assignments SET status='removed',removed_at=?
      WHERE org_id=? AND project_id=? AND agent_id=? AND migration_state='legacy_unversioned'
        AND status IN ('active','disabled')`,now,c.org_id,c.project_id,id);
    if (changed.changes !== 1) throw new StorageError("AGENT_REFERENCED");
    this.tx.run(`UPDATE agent_identities SET removed_at=? WHERE org_id=? AND id=?`,now,c.org_id,id);
  }
  adopt(id: string): void {
    const c = this.context;
    const changed = this.tx.run(`UPDATE agent_identities SET identity_state='governed',agent_principal_id=id
      WHERE org_id=? AND id=? AND home_project_id=? AND owner_principal_type=? AND owner_principal_id=?
        AND identity_state='legacy_unresolved'`, c.org_id,id,c.project_id,c.principal.type,c.principal.id);
    if (changed.changes !== 1) throw new StorageError("AGENT_NOT_FOUND");
    this.tx.run(`UPDATE project_agent_assignments SET migration_state='governed'
      WHERE org_id=? AND project_id=? AND agent_id=? AND migration_state='legacy_unversioned'`, c.org_id,c.project_id,id);
  }
  promote(id: string): void {
    const c = this.context;
    const changed = this.tx.run(`UPDATE agent_identities SET visibility='organization'
      WHERE org_id=? AND id=? AND home_project_id=? AND visibility='project' AND identity_state='governed'`,
      c.org_id,id,c.project_id);
    if (changed.changes !== 1) throw new StorageError("AGENT_NOT_FOUND");
  }
  assignmentForAgent(agentId: string): AssignmentRow | null {
    const c = this.context;
    return (this.tx.get(`SELECT * FROM project_agent_assignments WHERE org_id=? AND project_id=?
      AND agent_id=?`,c.org_id,c.project_id,agentId) as unknown as AssignmentRow | undefined) ?? null;
  }
  assignment(id: string): AssignmentRow | null {
    const c = this.context;
    return (this.tx.get("SELECT * FROM project_agent_assignments WHERE org_id=? AND project_id=? AND id=?",
      c.org_id,c.project_id,id) as unknown as AssignmentRow | undefined) ?? null;
  }
  list(limit: number, offset: number): AssignmentRow[] {
    const c = this.context;
    return this.tx.all(`SELECT * FROM project_agent_assignments
      WHERE org_id=? AND project_id=? ORDER BY created_at,id LIMIT ? OFFSET ?`,
      c.org_id,c.project_id,limit,offset) as unknown as AssignmentRow[];
  }
  version(assignmentId: string, versionId: string): Record<string,unknown> | null {
    const c = this.context;
    const row=this.tx.get(`SELECT contract_json FROM project_agent_assignment_versions
      WHERE org_id=? AND project_id=? AND assignment_id=? AND id=?`,
      c.org_id,c.project_id,assignmentId,versionId);
    return row ? JSON.parse(String(row.contract_json)) as Record<string,unknown> : null;
  }
  add(id: string, agentId: string, now: string): void {
    const c = this.context;
    this.tx.run(`INSERT INTO project_agent_assignments
      (org_id,id,project_id,agent_id,status,migration_state,created_at)
      VALUES (?,?,?,?,'active','governed',?)`, c.org_id,id,c.project_id,agentId,now);
  }
  status(id: string, from: string, to: string, now: string): void {
    const c = this.context;
    const changed = this.tx.run(`UPDATE project_agent_assignments SET status=?,removed_at=?
      WHERE org_id=? AND project_id=? AND id=? AND status=?`,
      to,to==="removed"?now:null,c.org_id,c.project_id,id,from);
    if (changed.changes !== 1) throw new StorageError("ASSIGNMENT_STATE_CONFLICT");
  }
  latestRevision(id: string): number {
    const c = this.context;
    return Number(this.tx.get(`SELECT coalesce(max(revision),0) AS n FROM project_agent_assignment_versions
      WHERE org_id=? AND assignment_id=?`,c.org_id,id)!.n);
  }
  hasConfigureReplay(idempotencyKey: string): boolean {
    const c=this.context;
    return !!this.tx.get(`SELECT 1 FROM command_commits WHERE org_id=? AND project_id=?
      AND principal_type=? AND principal_id=? AND command='assignment.configure' AND idempotency_key=?`,
    c.org_id,c.project_id,c.principal.type,c.principal.id,idempotencyKey);
  }
  sourceVersion(agent: IdentityRow, versionId: string): { id: string; definition_json: string;
    soul_content:string|null;soul_hash:string|null } | null {
    const c = this.context;
    const row = this.tx.get(`SELECT v.id,v.definition_json,s.content AS soul_content,
      s.content_hash AS soul_hash FROM local_agent_versions v
      LEFT JOIN local_agent_soul_snapshots s ON s.org_id=v.org_id AND s.project_id=v.project_id
        AND s.principal_type=v.principal_type AND s.principal_id=v.principal_id
        AND s.agent_id=v.agent_id AND s.version_id=v.id
      WHERE v.org_id=? AND v.project_id=?
      AND v.principal_type=? AND v.principal_id=? AND v.agent_id=? AND v.id=?`,
      c.org_id,agent.home_project_id,agent.owner_principal_type,agent.owner_principal_id,agent.id,versionId);
    return row ? { id: String(row.id), definition_json: String(row.definition_json),
      soul_content:row.soul_content===null?null:String(row.soul_content),
      soul_hash:row.soul_hash===null?null:String(row.soul_hash) } : null;
  }
  latestSourceVersion(agent: IdentityRow): { id: string; definition_json: string } | null {
    const c=this.context;
    const row=this.tx.get(`SELECT v.id,v.definition_json FROM local_agents a
      JOIN local_agent_versions v ON v.org_id=a.org_id AND v.project_id=a.project_id
        AND v.principal_type=a.principal_type AND v.principal_id=a.principal_id
        AND v.agent_id=a.id AND v.id=a.latest_version_id
      WHERE a.org_id=? AND a.project_id=? AND a.principal_type=? AND a.principal_id=?
        AND a.id=? AND a.node_type='agent' AND a.deleted_at IS NULL`,
      c.org_id,agent.home_project_id,agent.owner_principal_type,agent.owner_principal_id,agent.id);
    return row ? {id:String(row.id),definition_json:String(row.definition_json)} : null;
  }
  appendVersion(id: string, assignment: AssignmentRow, agent: IdentityRow, agentVersionId: string,
                revision: number, contract: Record<string, unknown>, now: string): void {
    const c = this.context;
    this.tx.run(`INSERT INTO project_agent_assignment_versions
      (org_id,id,assignment_id,project_id,agent_id,revision,agent_version_id,agent_home_project_id,
       agent_owner_principal_type,agent_owner_principal_id,contract_json,resolved_config_hash,
       authority_ceiling_hash,memory_scope_hash,created_by_principal_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,c.org_id,id,assignment.id,assignment.project_id,agent.id,revision,
      agentVersionId,agent.home_project_id,agent.owner_principal_type,agent.owner_principal_id,
      JSON.stringify(contract),contract.resolvedConfigHash as string,contract.authorityCeilingHash as string,
      contract.memoryScopeHash as string,c.principal.id,now);
    this.tx.run(`UPDATE project_agent_assignments SET current_assignment_version_id=?
      WHERE org_id=? AND project_id=? AND id=?`,id,c.org_id,c.project_id,assignment.id);
  }
  event(type: "created"|"adopted"|"added"|"version_released"|"disabled"|"enabled"|"removed"|"promoted",
        agentId: string, assignmentId: string | null, now: string): void {
    const c=this.context;
    this.tx.run(`INSERT INTO project_agent_assignment_events
      (org_id,id,project_id,agent_id,assignment_id,event_type,actor_principal_type,actor_principal_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,c.org_id,randomUUID(),c.project_id,agentId,assignmentId,type,
      c.principal.type,c.principal.id,now);
  }
}
