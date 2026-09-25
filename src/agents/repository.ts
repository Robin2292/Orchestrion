import { ToolGrantRepository } from "../grants/repository";
import { LocalContextSchema, type LocalContext } from "../shared/local-contracts";
import { LocalAgentSchema, LocalAgentVersionSchema, type LocalAgent, type LocalAgentVersion } from "../shared/agent-contracts";
import { ProjectRepository, StorageError, SqliteFoundation, type SqliteUnit } from "../storage/sqlite/foundation";
import { verifyAgentSoul } from "./soul-document";

export const AGENT_FENCE = "local-agents";
export const AGENT_INITIAL_HASH = `sha256:${"0".repeat(64)}`;
/** All SQL is confined to this scoped repository. No caller-selected authority. */
export class AgentRepository {
  readonly context: LocalContext;
  private readonly scope: string[];
  private readonly where = "org_id=? AND project_id=? AND principal_type=? AND principal_id=?";
  constructor(private readonly tx: SqliteUnit, context: LocalContext) {
    this.context = LocalContextSchema.parse(context);
    new ProjectRepository(tx, this.context);
    const c = this.context;
    this.scope = [c.org_id, c.project_id, c.principal.type, c.principal.id];
  }
  authorize(write = false): void {
    const c = this.context;
    const m = this.tx.get("SELECT role FROM memberships WHERE org_id=? AND principal_type=? AND principal_id=?",
      c.org_id, c.principal.type, c.principal.id);
    if (!m || (write && !["owner", "admin", "editor"].includes(String(m.role)))) throw new StorageError("NOT_AUTHENTICATED");
  }
  ensureFence(): void {
    if (!this.tx.get("SELECT 1 FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",
      this.context.org_id, this.context.project_id, AGENT_FENCE))
      SqliteFoundation.createFence(this.tx, this.context, AGENT_FENCE, AGENT_INITIAL_HASH);
  }
  pin() {
    const row = this.tx.get("SELECT revision,hash FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",
      this.context.org_id, this.context.project_id, AGENT_FENCE)!;
    return { revision: Number(row.revision), hash: String(row.hash) };
  }
  get(id: string): LocalAgent | null {
    const r = this.tx.get(`SELECT * FROM local_agents WHERE ${this.where} AND id=?`, ...this.scope, id);
    return r ? LocalAgentSchema.parse({ schemaVersion: "orchestrion.local.agent.v1", context: this.context,
      id: r.id, nodeType: r.node_type, name: r.name, description: r.description, userGuide: r.user_guide,
      legacyDraft: r.legacy_instructions === null ? null : { instructions: r.legacy_instructions },
      latestVersionId: r.latest_version_id, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at }) : null;
  }
  list(limit: number, offset: number): LocalAgent[] {
    return this.tx.all(`SELECT id FROM local_agents WHERE ${this.where} AND deleted_at IS NULL ORDER BY created_at,id LIMIT ? OFFSET ?`,
      ...this.scope, limit, offset).map((r) => this.get(String(r.id))!);
  }
  insert(a: LocalAgent): void {
    this.tx.run(`INSERT INTO local_agents
      (org_id,project_id,principal_type,principal_id,id,node_type,name,description,user_guide,legacy_instructions,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ...this.scope, a.id, a.nodeType, a.name, a.description, a.userGuide,
      a.legacyDraft?.instructions ?? null, a.createdAt, a.updatedAt);
  }
  update(id: string, name: string, description: string | null, guide: string | null, now: string): void {
    this.tx.run(`UPDATE local_agents SET name=?,description=?,user_guide=?,updated_at=? WHERE ${this.where} AND id=?`,
      name, description, guide, now, ...this.scope, id);
  }
  version(agentId: string, id: string): LocalAgentVersion | null {
    const r = this.tx.get(`SELECT * FROM local_agent_versions WHERE ${this.where} AND agent_id=? AND id=?`, ...this.scope, agentId, id);
    if (!r) return null;
    const soul = this.tx.get(`SELECT content,content_hash FROM local_agent_soul_snapshots
      WHERE ${this.where} AND agent_id=? AND version_id=?`, ...this.scope, agentId, id);
    const definition = JSON.parse(String(r.definition_json));
    return LocalAgentVersionSchema.parse({ schemaVersion: "orchestrion.local.agent.v1", context: this.context,
      id: r.id, agentId: r.agent_id, versionNumber: r.version_number, definition,
      ...(soul ? { soul: verifyAgentSoul({ content: String(soul.content), hash: String(soul.content_hash) },
        definition.systemPrompt ?? null) } : {}),
      createdAt: r.created_at });
  }
  versions(agentId: string, limit: number, offset: number): LocalAgentVersion[] {
    return this.tx.all(`SELECT id FROM local_agent_versions WHERE ${this.where} AND agent_id=? ORDER BY version_number DESC LIMIT ? OFFSET ?`,
      ...this.scope, agentId, limit, offset).map((r) => this.version(agentId, String(r.id))!);
  }
  insertVersion(v: LocalAgentVersion): void {
    const grants = new ToolGrantRepository(this.tx, this.context);
    grants.validate(v.definition.toolGrants);
    this.tx.run(`INSERT INTO local_agent_versions VALUES (?,?,?,?,?,?,?,?,?,?)`, ...this.scope,
      v.agentId, v.id, v.definition.nodeType, v.versionNumber, JSON.stringify(v.definition), v.createdAt);
    if (v.soul) this.tx.run(`INSERT INTO local_agent_soul_snapshots VALUES (?,?,?,?,?,?,?,?)`, ...this.scope,
      v.agentId, v.id, v.soul.content, v.soul.hash);
    this.tx.run(`UPDATE local_agents SET latest_version_id=?,updated_at=? WHERE ${this.where} AND id=?`,
      v.id, v.createdAt, ...this.scope, v.agentId);
  }
  referenced(id: string): boolean {
    return !!this.tx.get(`SELECT 1 FROM local_legacy_sessions WHERE ${this.where} AND agent_id=? LIMIT 1`, ...this.scope, id)
      || !!this.tx.get(`SELECT 1 FROM local_session_tree_agents WHERE ${this.where} AND agent_id=? LIMIT 1`, ...this.scope, id);
  }
  delete(id: string, now: string): void {
    this.tx.run(`UPDATE local_agents SET deleted_at=?,updated_at=? WHERE ${this.where} AND id=?`, now, now, ...this.scope, id);
  }
  legacySessions() {
    return this.tx.all(`SELECT record_json FROM local_legacy_sessions WHERE ${this.where} ORDER BY id`, ...this.scope)
      .map((r) => JSON.parse(String(r.record_json)) as unknown);
  }
}
