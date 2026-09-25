import { LocalContextSchema, type LocalContext } from "../shared/local-contracts";
import { type LegacyMetadata, LocalAgentSchema } from "../shared/agent-contracts";
import { StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { AgentRepository } from "./repository";
import { LocalAssignmentRepository } from "../assignments/repository";

/** Explicit personal-workspace import only. Identity maps and all records share
 * the caller's single SQLite transaction; no INSERT OR IGNORE of conflicts. */
export class AgentImportRepository {
  private readonly c: LocalContext;
  private readonly scope: string[];
  constructor(private readonly tx: SqliteUnit, context: LocalContext) {
    this.c = LocalContextSchema.parse(context);
    const r = new AgentRepository(tx, this.c); r.authorize(true);
    const personal = tx.get("SELECT * FROM personal_workspace WHERE singleton=1");
    if (!personal || personal.org_id !== this.c.org_id || personal.principal_type !== this.c.principal.type
      || personal.principal_id !== this.c.principal.id || personal.project_id !== this.c.project_id)
      throw new StorageError("CONTEXT_MISMATCH");
    this.scope = [this.c.org_id, this.c.principal.type, this.c.principal.id];
  }
  receipt(source: string) {
    return this.tx.get(`SELECT id,digest FROM local_legacy_imports WHERE org_id=? AND principal_type=? AND principal_id=? AND source_id=?`, ...this.scope, source);
  }
  mappings(importId: string) {
    return this.tx.all(`SELECT kind,legacy_id,project_id,local_id FROM local_legacy_identity_map
      WHERE org_id=? AND principal_type=? AND principal_id=? AND import_id=? ORDER BY kind,legacy_id`, ...this.scope, importId)
      .map((r) => ({ kind: String(r.kind), legacyId: String(r.legacy_id), projectId: String(r.project_id), localId: String(r.local_id) }));
  }
  insert(source: string, id: string, digest: string, data: LegacyMetadata, now: string): void {
    this.tx.run("INSERT INTO local_legacy_imports VALUES (?,?,?,?,?,?,?)", ...this.scope, source, id, digest, now);
    const map = (kind: string, legacyId: string, projectId: string) => {
      this.tx.run("INSERT INTO local_legacy_identity_map VALUES (?,?,?,?,?,?,?,?)", ...this.scope, id, kind, legacyId, projectId, legacyId);
    };
    for (const p of data.projects) {
      // An existing UUID is a conflict, never permission to adopt another project.
      this.tx.run("INSERT INTO projects VALUES (?,?,?)", this.c.org_id, p.id, p.name);
      this.tx.run("INSERT INTO local_legacy_projects VALUES (?,?,?,?,?)", this.c.org_id, p.id, this.c.principal.type, this.c.principal.id, JSON.stringify(p));
      map("project", p.id, p.id);
    }
    const agentProjects = new Map(data.agents.map((a) => [a.id, a.projectId]));
    for (const a of data.agents) {
      const context = { ...this.c, project_id: a.projectId };
      const repo = new AgentRepository(this.tx, context);
      repo.insert(LocalAgentSchema.parse({ schemaVersion: "orchestrion.local.agent.v1", context,
        id: a.id, nodeType: "agent", name: a.name, description: null, userGuide: null,
        latestVersionId: null, legacyDraft: { instructions: a.instructions },
        createdAt: a.createdAt, updatedAt: a.createdAt, deletedAt: null }));
      new LocalAssignmentRepository(this.tx,context).insertLegacyAgent(a.id,a.name,a.createdAt);
      repo.ensureFence(); map("agent", a.id, a.projectId);
    }
    for (const s of data.sessions) {
      const projectId = agentProjects.get(s.agentId)!;
      this.tx.run("INSERT INTO local_legacy_sessions VALUES (?,?,?,?,?,?,?)", this.c.org_id, projectId,
        this.c.principal.type, this.c.principal.id, s.id, s.agentId, JSON.stringify(s));
      map("session", s.id, projectId);
    }
  }
}
