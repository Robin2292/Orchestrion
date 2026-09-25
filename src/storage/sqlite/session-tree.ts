import type { AgentRecord, ProjectRecord, SessionRecord } from "../../shared/contracts";
import { LocalFolderIdentitySchema, type LocalFolderIdentity } from "../../shared/execution-attempt-contracts";
import type { LocalContext } from "../../shared/local-contracts";
import { GovernedTreeSessionSchema } from "../../shared/session-tree-contracts";
import { AgentRepository } from "../../agents/repository";
import { StorageError, type SqliteUnit } from "./foundation";

/** SQLite owns every governed tree record; JSON is never part of a write here. */
export class SessionTreeRepository {
  private readonly scope: string[];
  private readonly where = "org_id=? AND project_id=? AND principal_type=? AND principal_id=?";
  constructor(private readonly tx: SqliteUnit, readonly context: LocalContext) {
    new AgentRepository(tx, context).authorize();
    this.scope = [context.org_id, context.project_id, context.principal.type, context.principal.id];
  }
  project(): { record: ProjectRecord; identity: LocalFolderIdentity } | null {
    const row = this.tx.get(`SELECT * FROM local_session_tree_projects WHERE ${this.where}`, ...this.scope);
    return row ? { record: { id: this.context.project_id, name: "Personal · Governed", path: String(row.path),
      createdAt: String(row.created_at), executionMode: "governed" }, identity: LocalFolderIdentitySchema.parse(JSON.parse(String(row.identity_json))) } : null;
  }
  agents(): AgentRecord[] {
    return this.tx.all(`SELECT * FROM local_session_tree_agents WHERE ${this.where} ORDER BY created_at,agent_id`, ...this.scope)
      .map(row => ({ id: String(row.agent_id), projectId: this.context.project_id, name: String(row.name), instructions: String(row.instructions),
        createdAt: String(row.created_at), executionMode: "governed" as const, localAgentVersionId: String(row.version_id) }));
  }
  bind(path: string, identity: LocalFolderIdentity, agent: AgentRecord): AgentRecord {
    new AgentRepository(this.tx, this.context).authorize(true);
    const project = this.project();
    if (project && (project.record.path !== path || JSON.stringify(project.identity) !== JSON.stringify(identity)))
      throw new StorageError("SESSION_FOLDER_CONFLICT");
    const prior = this.agents().find(row => row.id === agent.id);
    if (prior && prior.localAgentVersionId !== agent.localAgentVersionId) throw new StorageError("SESSION_VERSION_CONFLICT");
    if (prior) return prior;
    if (!project) this.tx.run("INSERT INTO local_session_tree_projects VALUES (?,?,?,?,?,?,?)", ...this.scope, path, JSON.stringify(identity), agent.createdAt);
    this.tx.run("INSERT INTO local_session_tree_agents VALUES (?,?,?,?,?,?,?,?,?)", ...this.scope,
      agent.id, agent.localAgentVersionId!, agent.name, agent.instructions, agent.createdAt);
    return agent;
  }
  sessions(): SessionRecord[] {
    const drafts=this.tx.all(`SELECT record_json FROM local_session_tree_sessions WHERE ${this.where} ORDER BY id`, ...this.scope);
    const cutover=this.tx.all(`SELECT d.compat_record_json AS record_json FROM direct_session_state d
      JOIN agent_sessions s ON s.org_id=d.org_id AND s.id=d.session_id AND s.project_id=d.project_id
      WHERE d.org_id=? AND d.project_id=? AND d.compat_principal_type=? AND d.compat_principal_id=?
        AND d.compat_record_json IS NOT NULL AND d.deleted_at IS NULL AND s.provenance='legacy_unversioned'
      ORDER BY d.session_id`,...this.scope);
    return [...drafts,...cutover]
      .map(row => GovernedTreeSessionSchema.parse(JSON.parse(String(row.record_json))));
  }
  session(id: string): SessionRecord | null {
    const row = this.tx.get(`SELECT record_json FROM local_session_tree_sessions WHERE ${this.where} AND id=?`, ...this.scope, id)
      ?? this.tx.get(`SELECT d.compat_record_json AS record_json FROM direct_session_state d
        JOIN agent_sessions s ON s.org_id=d.org_id AND s.id=d.session_id AND s.project_id=d.project_id
        WHERE d.org_id=? AND d.project_id=? AND d.compat_principal_type=? AND d.compat_principal_id=?
          AND d.session_id=? AND d.compat_record_json IS NOT NULL AND d.deleted_at IS NULL
          AND s.provenance='legacy_unversioned'`,...this.scope,id);
    return row ? GovernedTreeSessionSchema.parse(JSON.parse(String(row.record_json))) : null;
  }
  insert(session: SessionRecord): void {
    new AgentRepository(this.tx, this.context).authorize(true);
    const value = GovernedTreeSessionSchema.parse(session);
    this.tx.run("INSERT INTO local_session_tree_sessions VALUES (?,?,?,?,?,?,?)", ...this.scope, value.id, value.agentId, JSON.stringify(value));
  }
  update(session: SessionRecord): void {
    new AgentRepository(this.tx, this.context).authorize(true);
    const value = GovernedTreeSessionSchema.parse(session);
    const prior=this.tx.get(`SELECT record_json FROM local_session_tree_sessions WHERE ${this.where} AND id=? AND agent_id=?`,
      ...this.scope,value.id,value.agentId);
    if (prior) {
      const old=GovernedTreeSessionSchema.parse(JSON.parse(String(prior.record_json)));
      if (old.threadId!==null && old.threadId!==value.threadId) throw new StorageError("SESSION_BINDING_INVALID");
      const eligible=!!this.tx.get(`SELECT 1 FROM local_agents a WHERE a.org_id=? AND a.project_id=?
        AND a.principal_type=? AND a.principal_id=? AND a.id=? AND a.node_type='agent'`,
        ...this.scope,value.agentId);
      if (old.threadId===null && value.threadId!==null && eligible) {
        // The first real provider thread is the atomic single-writer cutover.
        // The immutable projection records legacy provenance, never release pins.
        const c=this.context;
        this.tx.run(`INSERT INTO agent_sessions(org_id,id,project_id,agent_id,source,lifecycle,provenance,
          assignment_id,memory_scope_json,original_thread_id,legacy_configuration_evidence,created_at)
          VALUES (?,?,?,?,'direct','active','legacy_unversioned',?,?,?,?,?)`,
          c.org_id,value.id,c.project_id,value.agentId,`assignment:${value.agentId}`,
          JSON.stringify({type:"direct",projectId:c.project_id,sessionId:value.id,sharing:"session_only"}),
          value.threadId,JSON.stringify({source:"local_session_tree_sessions",record:value}),value.createdAt);
        this.tx.run(`INSERT INTO direct_session_state(org_id,session_id,project_id,title,updated_at,
          compat_record_json,compat_principal_type,compat_principal_id) VALUES (?,?,?,?,?,?,?,?)`,
          c.org_id,value.id,c.project_id,value.title,value.updatedAt,JSON.stringify(value),
          c.principal.type,c.principal.id);
        const moved=this.tx.run(`DELETE FROM local_session_tree_sessions WHERE ${this.where} AND id=? AND agent_id=?`,
          ...this.scope,value.id,value.agentId);
        if (moved.changes!==1) throw new StorageError("SESSION_BINDING_INVALID");
        return;
      }
    }
    const changed=prior
      ? this.tx.run(`UPDATE local_session_tree_sessions SET record_json=? WHERE ${this.where} AND id=? AND agent_id=?`,
        JSON.stringify(value),...this.scope,value.id,value.agentId)
      : this.tx.run(`UPDATE direct_session_state SET compat_record_json=?,title=?,updated_at=?
          WHERE org_id=? AND project_id=? AND compat_principal_type=? AND compat_principal_id=?
            AND session_id=? AND deleted_at IS NULL AND EXISTS (
              SELECT 1 FROM agent_sessions s WHERE s.org_id=direct_session_state.org_id
                AND s.id=direct_session_state.session_id AND s.agent_id=?
                AND s.original_thread_id=? AND s.provenance='legacy_unversioned')`,
        JSON.stringify(value),value.title,value.updatedAt,...this.scope,value.id,value.agentId,value.threadId);
    if (changed.changes !== 1) throw new StorageError("SESSION_BINDING_INVALID");
  }
  delete(id: string): void {
    new AgentRepository(this.tx, this.context).authorize(true);
    const removed=this.tx.run(`DELETE FROM local_session_tree_sessions WHERE ${this.where} AND id=?`, ...this.scope, id);
    if (removed.changes===1) return;
    const changed=this.tx.run(`UPDATE direct_session_state SET deleted_at=?,updated_at=?
      WHERE org_id=? AND project_id=? AND compat_principal_type=? AND compat_principal_id=?
        AND session_id=? AND compat_record_json IS NOT NULL AND deleted_at IS NULL`,
      new Date().toISOString(),new Date().toISOString(),...this.scope,id);
    if (changed.changes!==1) throw new StorageError("SESSION_BINDING_INVALID");
  }
}
