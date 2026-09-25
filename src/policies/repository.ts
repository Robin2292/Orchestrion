import { randomUUID, createHash } from "node:crypto";
import type { LocalContext } from "../shared/local-contracts";
import { PolicyReleaseSchema, type PolicyRelease, type PolicyTarget } from "../shared/policy/p1-contracts";
import { canonical, parseCanonical, type Json } from "../shared/policy/p0-canonical";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";

export const POLICY_FENCE = "local-policy-releases";
export function policyHash(material: Json): string {
  return `sha256:${createHash("sha256").update(canonical(material)).digest("hex")}`;
}
export function releaseHash(r: Omit<PolicyRelease, "releaseHash" | "lifecycle" | "stateRevision">, context: LocalContext): string {
  return policyHash({ context, ...r });
}
export class PolicyRepository {
  private readonly scope: string[];
  private readonly where = "org_id=? AND project_id=? AND principal_type=? AND principal_id=?";
  constructor(private readonly tx: SqliteUnit, readonly context: LocalContext) {
    this.scope = [context.org_id, context.project_id, context.principal.type, context.principal.id];
  }
  authorize(write = false, approve = false) {
    const row = this.tx.get("SELECT role FROM memberships WHERE org_id=? AND principal_type=? AND principal_id=?",
      this.context.org_id, this.context.principal.type, this.context.principal.id);
    const roles = approve ? ["owner", "admin"] : write ? ["owner", "admin", "editor"] : ["owner", "admin", "editor", "viewer"];
    if (!row || !roles.includes(String(row.role))) throw new StorageError("NOT_AUTHENTICATED");
  }
  ensureFence() {
    const c = this.context;
    if (!this.tx.get("SELECT 1 FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?", c.org_id, c.project_id, POLICY_FENCE))
      SqliteFoundation.createFence(this.tx, c, POLICY_FENCE, `sha256:${"0".repeat(64)}`);
  }
  pin() {
    const c = this.context, row = this.tx.get("SELECT revision,hash FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?", c.org_id,c.project_id,POLICY_FENCE)!;
    return { revision: Number(row.revision), hash: String(row.hash) };
  }
  binding(target: PolicyTarget, toolName: string) {
    return this.tx.get(`SELECT id FROM local_policy_bindings WHERE ${this.where} AND target_json=? AND tool_name=?`, ...this.scope, canonical(target), toolName);
  }
  createBinding(target: PolicyTarget, toolName: string): string {
    const prior = this.binding(target, toolName); if (prior) return String(prior.id);
    const id = randomUUID(); this.tx.run("INSERT INTO local_policy_bindings VALUES (?,?,?,?,?,?,?)", ...this.scope, id, canonical(target), toolName); return id;
  }
  nextRevision(bindingId: string): number {
    return Number(this.tx.get(`SELECT coalesce(max(revision),0)+1 AS n FROM local_policy_releases WHERE ${this.where} AND binding_id=?`, ...this.scope, bindingId)!.n);
  }
  insert(r: PolicyRelease) {
    this.tx.run(`INSERT INTO local_policy_releases
      (org_id,project_id,principal_type,principal_id,id,binding_id,revision,definition_json,scope_json,release_hash,hash_schema,tool_anchor_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...this.scope, r.id,r.bindingId,r.revision,
      canonical(r.definition),canonical(r.scope),r.releaseHash,"direct_policy_v2",canonical(r.toolAnchor),r.createdAt);
    this.tx.run("INSERT INTO local_policy_states VALUES (?,?,?,?,?,?,?,?)", ...this.scope,r.id,"draft",0,r.createdAt);
  }
  get(id: string): PolicyRelease {
    const row = this.tx.get(`SELECT * FROM local_policy_releases WHERE ${this.where} AND id=?`, ...this.scope,id);
    if (!row) throw new StorageError("POLICY_NOT_FOUND");
    const state = this.tx.get(`SELECT * FROM local_policy_states WHERE ${this.where} AND release_id=?`, ...this.scope,id)!;
    const binding = this.tx.get(`SELECT * FROM local_policy_bindings WHERE ${this.where} AND id=?`, ...this.scope,String(row.binding_id))!;
    if (row.hash_schema !== "direct_policy_v2") throw new StorageError("TG5_LEGACY_POLICY_BACKUP_RESTORE_REQUIRED");
    const r = PolicyReleaseSchema.parse({ schemaVersion: "orchestrion.local.policy.v2", id, bindingId: row.binding_id, revision: row.revision,
      target: parseCanonical(String(binding.target_json)), toolName: binding.tool_name, definition: parseCanonical(String(row.definition_json)),
      scope: parseCanonical(String(row.scope_json)), toolAnchor: parseCanonical(String(row.tool_anchor_json)), releaseHash: row.release_hash, createdAt: row.created_at,
      lifecycle: state.lifecycle, stateRevision: state.revision });
    const { releaseHash: hash, lifecycle: _l, stateRevision: _s, ...material } = r; void _l; void _s;
    if (releaseHash(material, this.context) !== hash) throw new StorageError("POLICY_HASH_CONFLICT");
    return r;
  }
  list(limit = 10_000): PolicyRelease[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new StorageError("INVALID_PAYLOAD");
    return this.tx.all(`SELECT id FROM local_policy_releases WHERE ${this.where} ORDER BY created_at DESC,id DESC LIMIT ?`,
      ...this.scope,limit).map((row) => this.get(String(row.id)));
  }
  transition(r: PolicyRelease, lifecycle: PolicyRelease["lifecycle"], now: string) {
    this.tx.run(`UPDATE local_policy_states SET lifecycle=?,revision=revision+1,updated_at=? WHERE ${this.where} AND release_id=? AND revision=?`,
      lifecycle,now,...this.scope,r.id,r.stateRevision);
  }
  latest(bindingId: string) {
    const row = this.tx.get(`SELECT * FROM local_policy_activations WHERE ${this.where} AND binding_id=? ORDER BY sequence DESC LIMIT 1`, ...this.scope,bindingId);
    return row ? { id: String(row.id), releaseId: String(row.release_id), sequence: Number(row.sequence), action: String(row.action) } : null;
  }
  wasActive(bindingId: string, id: string): boolean {
    const row = this.tx.get(`SELECT action FROM local_policy_activations WHERE ${this.where} AND binding_id=? AND release_id=? ORDER BY sequence DESC LIMIT 1`, ...this.scope,bindingId,id);
    return !!row && row.action !== "deactivate";
  }
  newerPublished(r: PolicyRelease): boolean {
    return this.tx.all(`SELECT id FROM local_policy_releases WHERE ${this.where} AND binding_id=? AND revision>?`, ...this.scope,r.bindingId,r.revision)
      .some((row) => this.get(String(row.id)).lifecycle === "published");
  }
  select(r: PolicyRelease, action: string, sequence: number, now: string) {
    const id = randomUUID();
    this.tx.run("INSERT INTO local_policy_activations VALUES (?,?,?,?,?,?,?,?,?,?)", ...this.scope,id,r.bindingId,sequence,r.id,action,now); return id;
  }
}
