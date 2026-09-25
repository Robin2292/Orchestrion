import { resolve } from "node:path";
import { AgentRepository } from "../agents/repository";
import type { LocalAgentVersion } from "../shared/agent-contracts";
import type { AgentRecord, ProjectRecord, SessionRecord } from "../shared/contracts";
import {
  EXECUTABLE_PLACEMENTS, ExecutionAuthorityRequestSchema, RESOLVABLE_LIFECYCLES, executionRefusal,
  type ExecutionAttempt, type ExecutionAuthorityRefusal, type ExecutionAuthorityRequest, type LocalFolderIdentity,
} from "../shared/execution-attempt-contracts";
import type { ExecutionPlacementBinding } from "../shared/execution-placement-contracts";
import type { LocalContext, RuntimeOwner } from "../shared/local-contracts";
import { ExecutionAttemptRepository, executionBindingHash } from "../storage/sqlite/execution-attempts";
import { StorageError, type SqliteFoundation, type SqliteUnit } from "../storage/sqlite/foundation";
import type { MetadataStore } from "./store";
import { nodeWorkspaceFileSystem, snapshotProjectRoot, type WorkspaceFileSystem } from "./workspace-files";

interface Chain { session: SessionRecord; agent: AgentRecord; project: ProjectRecord }
interface Facts { attempt: ExecutionAttempt; agentVersion: LocalAgentVersion; owner: RuntimeOwner }
type Derived = { ok: true; chain: Chain; facts: Facts } | ExecutionAuthorityRefusal;

/** A validated binding for a later execution slice to consume. It grants no Tool,
 * Policy or Workflow authority; those still pass through their own registries.
 *
 * Consumption contract: this value is point-in-time. Nothing stops a lifecycle
 * flip or a runtime restart between resolve() returning and a consumer acting,
 * so a consumer must CAS on `attempt.revision` through
 * ExecutionAttemptRepository.transition() in the same SQLite transaction as its
 * first side effect, and must re-read runtime_incarnation against `owner` inside
 * that transaction. A failed CAS or owner mismatch means: do not act, resolve again. */
export interface ResolvedExecutionAuthority {
  context: LocalContext;
  session: { id: string; agentId: string; threadId: string | null };
  project: { id: string; path: string; canonicalPath: string };
  agentVersion: LocalAgentVersion;
  attempt: Pick<ExecutionAttempt, "session_id" | "attempt_id" | "lifecycle" | "revision" | "bound_at">;
  placement: ExecutionPlacementBinding;
  workspace: LocalFolderIdentity;
  owner: RuntimeOwner;
}
export type ExecutionAuthorityResolution = { ok: true; authority: ResolvedExecutionAuthority } | ExecutionAuthorityRefusal;

/** Re-derives execution authority from first principles on every call: the JSON
 * session → agent → project chain, the exact immutable AgentVersion, the frozen
 * placement, the live folder identity and the live runtime incarnation. Nothing
 * passed in or cached is trusted, nothing is written and no fallback is ever chosen.
 *
 * Owner policy: an attempt bound by a different runtime incarnation is refused with
 * EXECUTION_OWNER_STALE. A process restart advances runtime_incarnation, which makes
 * every earlier attempt permanently stale; that fact is derivable on each call, so
 * no durable flag is written here. The requires_rebind lifecycle stays a deliberate,
 * command-path decision by the caller that owns the attempt, and is refused here too.
 *
 * Only StorageError codes that describe a refusal are translated; storage failures
 * and corruption outside this table propagate as thrown errors. */
export class ExecutionAuthorityResolver {
  constructor(private readonly store: SqliteFoundation, private readonly metadata: Pick<MetadataStore, "read">,
    private readonly fileSystem: WorkspaceFileSystem = nodeWorkspaceFileSystem) {}

  /** Point-in-time only; see ResolvedExecutionAuthority for what a consumer must
   * re-check (revision CAS + owner) inside its own side-effect transaction. */
  async resolve(raw: unknown): Promise<ExecutionAuthorityResolution> {
    const parsed = ExecutionAuthorityRequestSchema.safeParse(raw);
    if (!parsed.success) return executionRefusal("EXECUTION_REQUEST_INVALID");
    const first = await this.derive(parsed.data);
    if (!first.ok) return first;
    const { attempt, owner } = first.facts;
    const placement = attempt.placement;
    if (!EXECUTABLE_PLACEMENTS.includes(placement.placement) || placement.workspace.kind !== "local_folder" || attempt.workspace_identity === null) {
      return executionRefusal("EXECUTION_PLACEMENT_UNSUPPORTED");
    }
    if (attempt.lifecycle === "requires_rebind") return executionRefusal("EXECUTION_REBIND_REQUIRED");
    if (!RESOLVABLE_LIFECYCLES.includes(attempt.lifecycle)) return executionRefusal("EXECUTION_ATTEMPT_FINISHED");
    if (!sameOwner(attempt.owner, owner) || !sameOwner(owner, this.store.owner)) return executionRefusal("EXECUTION_OWNER_STALE");
    if (resolve(placement.workspace.path) !== resolve(first.chain.project.path)) return executionRefusal("EXECUTION_WORKSPACE_DRIFT");
    let live: LocalFolderIdentity;
    try {
      const root = await snapshotProjectRoot(first.chain.project.path, this.fileSystem);
      live = { kind: "local_folder", canonical_path: root.canonicalPath, dev: root.dev, ino: root.ino };
    } catch {
      return executionRefusal("EXECUTION_WORKSPACE_DRIFT");
    }
    const bound = attempt.workspace_identity;
    if (live.canonical_path !== bound.canonical_path || live.dev !== bound.dev || live.ino !== bound.ino
        || executionBindingHash(placement, live) !== attempt.binding_hash) return executionRefusal("EXECUTION_WORKSPACE_DRIFT");
    // The filesystem await released the store; every fact must derive identically again.
    const second = await this.derive(parsed.data);
    if (!second.ok || JSON.stringify(second) !== JSON.stringify(first)) return executionRefusal("EXECUTION_STATE_CHANGED");
    return {
      ok: true,
      authority: structuredClone({
        context: { org_id: this.store.workspace.org_id, principal: this.store.workspace.principal, project_id: first.chain.project.id },
        session: { id: first.chain.session.id, agentId: first.chain.session.agentId, threadId: first.chain.session.threadId },
        project: { id: first.chain.project.id, path: first.chain.project.path, canonicalPath: live.canonical_path },
        agentVersion: first.facts.agentVersion,
        attempt: { session_id: attempt.session_id, attempt_id: attempt.attempt_id, lifecycle: attempt.lifecycle, revision: attempt.revision, bound_at: attempt.bound_at },
        placement, workspace: live, owner,
      }),
    };
  }

  private async derive(request: ExecutionAuthorityRequest): Promise<Derived> {
    const metadata = await this.metadata.read();
    const session = metadata.sessions.find((candidate) => candidate.id === request.sessionId);
    if (!session) return executionRefusal("EXECUTION_SESSION_NOT_FOUND");
    const agent = metadata.agents.find((candidate) => candidate.id === session.agentId);
    if (!agent) return executionRefusal("EXECUTION_AGENT_NOT_FOUND");
    const project = metadata.projects.find((candidate) => candidate.id === agent.projectId);
    if (!project) return executionRefusal("EXECUTION_PROJECT_NOT_FOUND");
    const workspace = this.store.workspace;
    const context: LocalContext = { org_id: workspace.org_id, principal: workspace.principal, project_id: project.id };
    let facts: { ok: true; value: Facts } | ExecutionAuthorityRefusal;
    try {
      facts = this.store.transaction((tx) => this.facts(tx, context, session, agent, request.attemptId));
    } catch (error) {
      if (error instanceof StorageError && error.code === "CONTEXT_MISMATCH") return executionRefusal("EXECUTION_PROJECT_NOT_FOUND");
      if (error instanceof StorageError && error.code === "EXECUTION_BINDING_INVALID") return executionRefusal("EXECUTION_BINDING_INVALID");
      throw error;
    }
    if (!facts.ok) return facts;
    return { ok: true, chain: { session, agent, project }, facts: facts.value };
  }

  private facts(tx: SqliteUnit, context: LocalContext, session: SessionRecord, agent: AgentRecord, attemptId: string): { ok: true; value: Facts } | ExecutionAuthorityRefusal {
    const attempts = new ExecutionAttemptRepository(tx, context);
    const attempt = attempts.get(session.id, attemptId);
    if (!attempt) {
      const located = attempts.locate(attemptId);
      return executionRefusal(located && located.project_id !== context.project_id ? "EXECUTION_PROJECT_MISMATCH" : "EXECUTION_ATTEMPT_NOT_FOUND");
    }
    if (attempt.agent_id !== agent.id) return executionRefusal("EXECUTION_AGENT_MISMATCH");
    const agents = new AgentRepository(tx, context);
    agents.authorize();
    const local = agents.get(agent.id);
    if (!local || local.deletedAt !== null || local.latestVersionId === null) return executionRefusal("EXECUTION_AGENT_VERSION_MISSING");
    const agentVersion = agents.version(agent.id, attempt.agent_version_id);
    if (!agentVersion) return executionRefusal("EXECUTION_AGENT_VERSION_MISSING");
    const row = tx.get("SELECT instance_id,epoch FROM runtime_incarnation WHERE singleton=1");
    if (!row) return executionRefusal("EXECUTION_OWNER_STALE");
    const owner: RuntimeOwner = { engine: "local", instance_id: String(row.instance_id), epoch: Number(row.epoch) };
    return { ok: true, value: { attempt, agentVersion, owner } };
  }
}

function sameOwner(left: RuntimeOwner, right: RuntimeOwner): boolean {
  return left.engine === right.engine && left.instance_id === right.instance_id && left.epoch === right.epoch;
}
