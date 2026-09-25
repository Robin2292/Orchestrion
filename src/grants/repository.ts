import { createHash } from "node:crypto";
import { ToolGrantSetSchema, grantCanonicalJson, normalizeToolGrants, serializeToolGrants,
  LocalToolContractVersionSchema, LocalWorkflowVersionSchema,
  type LocalToolContractVersion, type LocalWorkflowVersion, type ToolGrantSet } from "../shared/tool-grant-contracts";
import { LocalContextSchema, type LocalContext } from "../shared/local-contracts";
import { LocalFolderIdentitySchema } from "../shared/execution-attempt-contracts";
import { StorageError, ProjectRepository, type SqliteUnit } from "../storage/sqlite/foundation";
import { canonicalToolProjection } from "../shared/tool-projection";

export function grantDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(grantCanonicalJson(value)).digest("hex")}`;
}
export function grantSetDigest(value: ToolGrantSet): string {
  return `sha256:${createHash("sha256").update(serializeToolGrants(value)).digest("hex")}`;
}

/** Storage and FK projection only. Runtime keeps the bounded legacy seam until
 * TG2; this repository never installs an Adapter, evaluates Policy or executes. */
export class ToolGrantRepository {
  private readonly context: LocalContext;
  private readonly scope: string[];
  private readonly where = "org_id=? AND project_id=? AND principal_type=? AND principal_id=?";
  constructor(private readonly tx: SqliteUnit, context: LocalContext) {
    this.context = LocalContextSchema.parse(context);
    new ProjectRepository(tx, this.context);
    this.scope = [context.org_id, context.project_id, context.principal.type, context.principal.id];
  }
  private authorize(write = false): void {
    const row = this.tx.get("SELECT role FROM memberships WHERE org_id=? AND principal_type=? AND principal_id=?",
      this.context.org_id, this.context.principal.type, this.context.principal.id);
    if (!row || (write && !["owner", "admin", "editor"].includes(String(row.role)))) throw new StorageError("NOT_AUTHENTICATED");
  }
  /** Internal trusted composition only; there is deliberately no IPC endpoint. */
  registerContract(raw: LocalToolContractVersion): void {
    this.authorize(true);
    const v = LocalToolContractVersionSchema.parse(raw);
    if (grantCanonicalJson(v.context) !== grantCanonicalJson(this.context)) throw new StorageError("CONTEXT_MISMATCH");
    // Reuse T1's contract projection hashing; do not invent another executor or
    // contract authority. JSON bytes must be the canonical existing projection.
    const body = canonicalToolProjection(JSON.parse(v.contract_json));
    const digest = `sha256:${createHash("sha256").update("orchestrion.local.tool-projection.v1\n" + body).digest("hex")}`;
    if (body !== v.contract_json || digest !== v.anchor.tool_contract_hash) throw new StorageError("TOOL_SCHEMA_DRIFT");
    this.tx.run(`INSERT INTO local_tool_contract_versions
      (org_id,project_id,principal_type,principal_id,id,source_namespace,tool_key,contract_hash,schema_hash,anchor_json,contract_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ...this.scope, v.anchor.tool_contract_version_id, v.tool.source, v.tool.key,
      v.anchor.tool_contract_hash, v.schema_hash, grantCanonicalJson(v.anchor), body);
  }
  validate(raw: ToolGrantSet | null | undefined): ToolGrantSet | null {
    this.authorize();
    if (raw == null) return null;
    const value = normalizeToolGrants(raw);
    for (const grant of value.grants) {
      const contract = this.tx.get(`SELECT * FROM local_tool_contract_versions WHERE ${this.where} AND id=? AND contract_hash=?`, ...this.scope, grant.contract.id, grant.contract.hash);
      if (!contract || contract.contract_hash !== grant.contract.hash || contract.source_namespace !== grant.tool.source
        || contract.tool_key !== grant.tool.key || contract.schema_hash !== grant.constraints.argument_schema_hash)
        throw new StorageError("TOOL_REFERENCE_INVALID");
      for (const pin of [grant.policy, grant.approval]) {
        if (!pin) continue;
        const policy = this.tx.get(`SELECT r.release_hash,r.tool_anchor_json,s.lifecycle FROM local_policy_releases r JOIN local_policy_states s
          USING (org_id,project_id,principal_type,principal_id) WHERE r.org_id=? AND r.project_id=? AND r.principal_type=? AND r.principal_id=?
          AND r.id=? AND s.release_id=r.id`, ...this.scope, pin.id);
        if (!policy || policy.release_hash !== pin.hash || policy.lifecycle !== "published" || policy.tool_anchor_json !== contract.anchor_json) throw new StorageError("TOOL_REFERENCE_INVALID");
      }
      if (grant.connection) {
        if (grant.connection.kind !== "local_connector") throw new StorageError("TOOL_REFERENCE_INVALID");
        const connection = this.tx.get(`SELECT id,config_json,auth_json FROM local_connectors WHERE ${this.where} AND id=? AND deleted_at IS NULL`, ...this.scope, grant.connection.id);
        if (!connection || grantDigest({ id: connection.id, config: JSON.parse(String(connection.config_json)), auth: JSON.parse(String(connection.auth_json)) }) !== grant.connection.authority_hash)
          throw new StorageError("TOOL_REFERENCE_INVALID");
      } else {
        const target = grant.execution_target!;
        if (target.kind !== "local_workspace" || target.id !== this.context.project_id) throw new StorageError("TOOL_REFERENCE_INVALID");
        const workspace = this.tx.get(`SELECT identity_json FROM local_session_tree_projects WHERE ${this.where}`, ...this.scope);
        if (!workspace || grantDigest(LocalFolderIdentitySchema.parse(JSON.parse(String(workspace.identity_json)))) !== target.workspace_hash)
          throw new StorageError("TOOL_REFERENCE_INVALID");
      }
    }
    return value;
  }
  agent(agentId: string, versionId: string): ToolGrantSet | null {
    this.authorize();
    const row = this.tx.get(`SELECT grants_json FROM local_version_tool_grants WHERE ${this.where} AND owner_kind='agent' AND agent_id=? AND agent_version_id=?`,
      ...this.scope, agentId, versionId);
    return row?.grants_json == null ? null : ToolGrantSetSchema.parse(JSON.parse(String(row.grants_json)));
  }
  insertWorkflow(raw: LocalWorkflowVersion): void {
    this.authorize(true);
    const v = LocalWorkflowVersionSchema.parse(raw);
    if (grantCanonicalJson(v.context) !== grantCanonicalJson(this.context)) throw new StorageError("CONTEXT_MISMATCH");
    const grants = this.validate(v.tool_grants), ceiling = this.validate(v.tool_grant_ceiling);
    JSON.parse(v.definition_json); // A definition is data, never executable code.
    this.tx.run("INSERT INTO local_workflow_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)", ...this.scope,
      v.workflow_id, v.id, v.version_number, v.definition_json, grantDigest(JSON.parse(v.definition_json)),
      grants === null ? null : serializeToolGrants(grants), ceiling === null ? null : serializeToolGrants(ceiling));
  }
  workflow(workflowId: string, versionId: string): LocalWorkflowVersion | null {
    this.authorize();
    const row = this.tx.get(`SELECT v.*,g.grants_json,g.ceiling_json FROM local_workflow_versions v
      JOIN local_version_tool_grants g ON v.org_id=g.org_id AND v.project_id=g.project_id AND v.principal_type=g.principal_type
        AND v.principal_id=g.principal_id AND v.workflow_id=g.workflow_id AND v.id=g.workflow_version_id
      WHERE v.org_id=? AND v.project_id=? AND v.principal_type=? AND v.principal_id=? AND v.workflow_id=? AND v.id=?`, ...this.scope, workflowId, versionId);
    return row ? LocalWorkflowVersionSchema.parse({ schema_version: "orchestrion.local.workflow-version.v1", context: this.context,
      workflow_id: row.workflow_id, id: row.id, version_number: row.version_number, definition_json: row.definition_json,
      tool_grants: row.grants_json === null ? null : JSON.parse(String(row.grants_json)),
      tool_grant_ceiling: row.ceiling_json === null ? null : JSON.parse(String(row.ceiling_json)) }) : null;
  }
}
