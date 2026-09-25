import { createHash } from "node:crypto";
import { LocalContextSchema, type LocalContext } from "../../shared/local-contracts";
import { ExecutionPlacementBindingSchema, type ExecutionPlacementBinding } from "../../shared/execution-placement-contracts";
import {
  EXECUTION_ATTEMPT_TRANSITIONS, ExecutionAttemptBindInputSchema, ExecutionAttemptLifecycleSchema, ExecutionAttemptSchema,
  WorkspaceIdentitySchema, type ExecutionAttempt, type ExecutionAttemptLifecycle, type WorkspaceIdentity,
} from "../../shared/execution-attempt-contracts";
import { canonical, type Json } from "../../shared/policy/p0-canonical";
import { ProjectRepository, StorageError, type SqliteUnit } from "./foundation";

/** Content identity of a frozen binding plus the folder identity observed for it.
 * Recomputing it from live inputs detects any later path, inode or placement drift. */
export function executionBindingHash(placement: ExecutionPlacementBinding, identity: WorkspaceIdentity): string {
  const value = { placement: ExecutionPlacementBindingSchema.parse(placement), workspace_identity: WorkspaceIdentitySchema.parse(identity) };
  return `sha256:${createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)) as Json)).digest("hex")}`;
}

/** Scoped SQL for execution attempts. Rows are A0/EP0 evidence: identity, binding and
 * owner never change; only the closed lifecycle advances. No execution happens here. */
export class ExecutionAttemptRepository {
  readonly context: LocalContext;
  private readonly scope: string[];
  private readonly where = "org_id=? AND project_id=? AND principal_type=? AND principal_id=?";
  constructor(private readonly tx: SqliteUnit, context: LocalContext) {
    this.context = LocalContextSchema.parse(context);
    new ProjectRepository(tx, this.context);
    const c = this.context;
    this.scope = [c.org_id, c.project_id, c.principal.type, c.principal.id];
  }
  /** A0 facts only: a live Agent that owns the exact immutable version. A LegacyDraft
   * Agent has no version, so it can never be bound. */
  agentVersionBindable(agentId: string, versionId: string): boolean {
    const agent = this.tx.get(`SELECT deleted_at,latest_version_id FROM local_agents WHERE ${this.where} AND id=?`, ...this.scope, agentId);
    if (!agent || agent.deleted_at !== null || agent.latest_version_id === null) return false;
    return !!this.tx.get(`SELECT 1 FROM local_agent_versions WHERE ${this.where} AND agent_id=? AND id=?`, ...this.scope, agentId, versionId);
  }
  bind(raw: unknown): ExecutionAttempt {
    const p = ExecutionAttemptBindInputSchema.parse(raw);
    if (p.placement.project_id !== this.context.project_id) throw new StorageError("CONTEXT_MISMATCH");
    if (!this.agentVersionBindable(p.agent_id, p.agent_version_id)) throw new StorageError("AGENT_VERSION_NOT_FOUND");
    if (this.locate(p.attempt_id)) throw new StorageError("EXECUTION_ATTEMPT_EXISTS");
    this.tx.run(`INSERT INTO local_execution_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...this.scope,
      p.session_id, p.attempt_id, p.agent_id, p.agent_version_id, p.placement.placement, JSON.stringify(p.placement),
      p.workspace_identity === null ? null : JSON.stringify(p.workspace_identity),
      executionBindingHash(p.placement, p.workspace_identity), p.owner.instance_id, p.owner.epoch, "bound", 0, p.bound_at, p.bound_at);
    return this.get(p.session_id, p.attempt_id)!;
  }
  get(sessionId: string, attemptId: string): ExecutionAttempt | null {
    const r = this.tx.get(`SELECT * FROM local_execution_attempts WHERE ${this.where} AND session_id=? AND attempt_id=?`,
      ...this.scope, sessionId, attemptId);
    return r ? this.load(r) : null;
  }
  /** Org/principal-scoped existence probe for mismatch diagnosis. Never returns binding content. */
  locate(attemptId: string): { project_id: string; session_id: string } | null {
    const c = this.context;
    const r = this.tx.get(`SELECT project_id,session_id FROM local_execution_attempts
      WHERE org_id=? AND principal_type=? AND principal_id=? AND attempt_id=?`, c.org_id, c.principal.type, c.principal.id, attemptId);
    return r ? { project_id: String(r.project_id), session_id: String(r.session_id) } : null;
  }
  /** Attempts of one session that can still be cancelled (bound or active). */
  openForSession(sessionId: string): { attempt_id: string; lifecycle: ExecutionAttemptLifecycle; revision: number }[] {
    return this.tx.all(`SELECT attempt_id,lifecycle,revision FROM local_execution_attempts WHERE ${this.where} AND session_id=? AND lifecycle IN ('bound','active') ORDER BY bound_at,attempt_id`,
      ...this.scope, sessionId).map((r) => ({ attempt_id: String(r.attempt_id), lifecycle: ExecutionAttemptLifecycleSchema.parse(r.lifecycle), revision: Number(r.revision) }));
  }
  transition(attemptId: string, from: ExecutionAttemptLifecycle, to: ExecutionAttemptLifecycle, expectedRevision: number, now: string): void {
    if (!EXECUTION_ATTEMPT_TRANSITIONS[ExecutionAttemptLifecycleSchema.parse(from)].includes(ExecutionAttemptLifecycleSchema.parse(to))
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new StorageError("EXECUTION_ATTEMPT_STATE_CONFLICT");
    const changed = this.tx.run(`UPDATE local_execution_attempts SET lifecycle=?,revision=?,updated_at=?
      WHERE ${this.where} AND attempt_id=? AND lifecycle=? AND revision=?`, to, expectedRevision + 1, now, ...this.scope, attemptId, from, expectedRevision);
    if (changed.changes !== 1) throw new StorageError("EXECUTION_ATTEMPT_STATE_CONFLICT");
  }
  private load(r: Record<string, unknown>): ExecutionAttempt {
    let attempt: ExecutionAttempt;
    try {
      attempt = ExecutionAttemptSchema.parse({
        context: this.context, session_id: r.session_id, attempt_id: r.attempt_id, agent_id: r.agent_id, agent_version_id: r.agent_version_id,
        placement: JSON.parse(String(r.placement_json)),
        workspace_identity: r.workspace_identity_json === null ? null : JSON.parse(String(r.workspace_identity_json)),
        owner: { engine: "local", instance_id: r.owner_instance_id, epoch: Number(r.owner_epoch) },
        binding_hash: r.binding_hash, lifecycle: r.lifecycle, revision: Number(r.revision), bound_at: r.bound_at, updated_at: r.updated_at,
      });
    } catch {
      throw new StorageError("EXECUTION_BINDING_INVALID");
    }
    if (attempt.placement.placement !== r.placement
        || executionBindingHash(attempt.placement, attempt.workspace_identity) !== attempt.binding_hash) {
      throw new StorageError("EXECUTION_BINDING_INVALID");
    }
    return attempt;
  }
}
