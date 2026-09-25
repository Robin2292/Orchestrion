import { createHash, randomUUID } from "node:crypto";
import { AgentRepository } from "../agents/repository";
import type { LocalToolInvocationService } from "../invocations/service";
import { LocalPolicyService, type PolicyHostResolver } from "../policies/service";
import { PolicyRepository } from "../policies/repository";
import type { LocalAgentVersion } from "../shared/agent-contracts";
import type { LocalFolderIdentity } from "../shared/execution-attempt-contracts";
import type { ExecutionPlacementBinding } from "../shared/execution-placement-contracts";
import {
  DynamicToolCallParamsSchema, FileReadArgumentsSchema, GOVERNED_FILE_READ_CONNECTION, GOVERNED_FILE_READ_CONNECTOR, GOVERNED_FILE_READ_MAX_BYTES,
  GOVERNED_FILE_READ_TOOL, GOVERNED_GIT_CONNECTION, GOVERNED_GIT_CONNECTOR,
  GOVERNED_LOGICAL_WORKSPACE_ROOT, GOVERNED_TOOLS, GOVERNED_TOOL_REASONS, governedDynamicToolSpec, governedRefusal, governedToolForWire,
  type DynamicToolCallResponse, type FunctionDynamicToolSpec, type GovernedToolEventInput, type GovernedToolName, type SessionGovernance,
} from "../shared/governed-tool-contracts";
import { LOCAL_CONTRACT_VERSION, type LocalContext } from "../shared/local-contracts";
import type { PolicyDefinition, PolicyTarget } from "../shared/policy/p1-contracts";
import type { InvocationHostProof, InvocationPolicyPinSchema, ToolInvocationPlan } from "../shared/tool-invocation-contracts";
import { ExecutionAttemptRepository } from "../storage/sqlite/execution-attempts";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { GovernedToolEventRepository } from "../storage/sqlite/governed-tool-events";
import { fileReadImplementation, normalizeFileReadPath } from "../tools/builtins/file-read";
import { gitImplementation, normalizeGitInvocation, type NormalizedGitInvocation } from "../tools/builtins/git-readonly";
import { ToolRegistry, ToolRegistryError, toolAnchor, toolDigest, toolJson } from "../tools/registry";
import { ToolGrantRepository, grantDigest } from "../grants/repository";
import { grantMaterial, type ToolGrant } from "../shared/tool-grant-contracts";
import { ToolDefinitionSchema, type ToolDefinition } from "../shared/tool-registry-contracts";
import { ExecutionAuthorityResolver, type ResolvedExecutionAuthority } from "./execution-authority";
import type { MetadataStore } from "./store";
import { WorkspaceAuthority, type WorkspaceReadOutcome } from "./workspace-authority";
import { GOVERNED_GIT_MAX_OUTPUT_BYTES, GOVERNED_GIT_TIMEOUT_MS, HostProcessExecutor,
  ProcessWorkspaceAuthority, type GitProcessOutcome, type ProcessEvidence } from "./host-process-executor";
import { nodeWorkspaceFileSystem, snapshotProjectRoot, type WorkspaceFileSystem } from "./workspace-files";
import type { z } from "zod";

type PolicyPin = z.infer<typeof InvocationPolicyPinSchema>;

export interface GovernedSessionInput { sessionId: string; agentId: string; projectId: string; projectPath: string }
export interface GovernedDeclaration { attemptId: string; tools: GovernedToolName[]; dynamicTools: FunctionDynamicToolSpec[] }
export interface GovernedCallInput { sessionId: string; governance: SessionGovernance | null; call: unknown; signal?: AbortSignal }
/** What DesktopRuntime consumes. Every method is fail-closed: `declare` returns
 * null whenever governed coverage cannot be proven (explicitly bound Sessions
 * refuse startup; legacy/native compatibility is decided by the runtime), and
 * `execute` always resolves to a redacted response, never throws. */
export interface GovernedToolHost {
  declare(input: GovernedSessionInput): Promise<GovernedDeclaration | null>;
  execute(input: GovernedCallInput): Promise<DynamicToolCallResponse>;
  /** Cancels the still-open attempts of a session (thread/start failure, session deletion). */
  release(sessionId: string): void;
  /** Bounded process-tree teardown. File-only hosts resolve immediately. */
  shutdown?(): Promise<void>;
}

export interface GovernedFileReadDependencies {
  /** Production Session-tree proof; absent only in isolated legacy host fixtures. */
  sessionBinding?: (input: GovernedSessionInput) => Promise<{ agentVersionId: string; identity: LocalFolderIdentity } | null>;
  store: () => SqliteFoundation;
  metadata: Pick<MetadataStore, "read">;
  registry: ToolRegistry;
  policy: () => LocalPolicyService;
  fileSystem?: WorkspaceFileSystem;
  process?: HostProcessExecutor;
  clock?: () => Date;
}

/** Seeded as a *draft* only when no release exists for a target. Publishing and
 * activating stay human actions in the Policy desk; a draft grants nothing. */
export const DEFAULT_FILE_READ_POLICY: PolicyDefinition = {
  policy_key: "file-read", scope: { workspace_dir: "/workspace" }, approval_required: false, default_decision: "deny",
  rules: [{ rule_id: "read-workspace", resource_type: "workspace_path", mode: "read",
    matcher: { kind: "path_prefix", value: "/workspace" }, decision: "allow", reason_code: "FILE_READ_WORKSPACE_ALLOWED" }],
};
export function defaultGovernedPolicy(tool: GovernedToolName): PolicyDefinition {
  if (tool === GOVERNED_FILE_READ_TOOL) return structuredClone(DEFAULT_FILE_READ_POLICY);
  return {
    policy_key: tool.replace(".", "-"), scope: { workspace_dir: GOVERNED_LOGICAL_WORKSPACE_ROOT }, approval_required: false, default_decision: "deny",
    rules: [{ rule_id: "read-workspace", resource_type: "workspace_path", mode: "read",
      matcher: { kind: "path_prefix", value: GOVERNED_LOGICAL_WORKSPACE_ROOT }, decision: "allow", reason_code: "GIT_READ_WORKSPACE_ALLOWED" }],
  };
}
const ORGANIZATION: PolicyTarget = { layer: "organization" };

/** Production PolicyHostResolver for the organization floor and the agent-version
 * leaf. Workflow/node layers stay unavailable. */
export function governedPolicyResolver(registry: ToolRegistry): PolicyHostResolver {
  return (tx, context, target, toolName) => {
    if (target.layer !== "organization" && target.layer !== "agent") return null;
    const definition = registry.list(context).find((candidate) => candidate.name === toolName);
    if (!definition) return null;
    if (target.layer === "organization") {
      return { context, connectorId: definition.connectorId, connectionId: definition.connectionId, lineage: [ORGANIZATION],
        scope: { workspace_dir: GOVERNED_LOGICAL_WORKSPACE_ROOT }, approvalRequired: false };
    }
    const agents = new AgentRepository(tx, context); agents.authorize();
    if (!agents.version(target.agentId, target.versionId)) return null;
    return { context, connectorId: definition.connectorId, connectionId: definition.connectionId, lineage: [ORGANIZATION, target],
      scope: { workspace_dir: GOVERNED_LOGICAL_WORKSPACE_ROOT }, approvalRequired: false };
  };
}

type ReleasedTool = { definition: ToolDefinition; grantHash: string };
interface Readiness { agentVersion: LocalAgentVersion; tools: Map<GovernedToolName, ReleasedTool> }
interface EventShape { event_type: GovernedToolEventInput["event_type"]; reason_code: string | null; plan_hash: string | null; result_hash: string | null; result_bytes: number | null; path: string | null; process?: ProcessEvidence | null }

export class GovernedFileReadHost implements GovernedToolHost {
  private readonly fileSystem: WorkspaceFileSystem;
  private readonly clock: () => Date;
  private readonly executions = new Set<Promise<DynamicToolCallResponse>>();
  constructor(private readonly deps: GovernedFileReadDependencies) {
    this.fileSystem = deps.fileSystem ?? nodeWorkspaceFileSystem;
    this.clock = deps.clock ?? (() => new Date());
  }
  private get context(): LocalContext { return this.deps.store().workspace; }
  private header(service: { authority(): { context: LocalContext; runtime_owner: unknown; expected: unknown; run: unknown } }) {
    return { schema_version: LOCAL_CONTRACT_VERSION, request_id: randomUUID(), idempotency_key: randomUUID(), ...service.authority() } as Parameters<LocalPolicyService["createDraft"]>[0];
  }

  /** Under the session lock, before thread/start. Registers reviewed built-ins
   * for the AgentVersion's exact ready direct grants, seeds missing policy drafts,
   * and only when both the organization floor and the agent-version leaf are
   * published+active binds a durable attempt and returns the declaration. */
  async declare(input: GovernedSessionInput): Promise<GovernedDeclaration | null> {
    let store: SqliteFoundation;
    try { store = this.deps.store(); } catch { return null; }
    const context = store.workspace;
    if (input.projectId !== context.project_id) return null;
    let binding: { agentVersionId: string; identity: LocalFolderIdentity } | null = null;
    if (this.deps.sessionBinding) {
      try { binding = await this.deps.sessionBinding(input); } catch { return null; }
      if (!binding) return null;
    }
    let readiness: Readiness | null;
    try { readiness = store.transaction((tx) => this.readiness(tx, context, input.agentId, binding?.agentVersionId)); } catch { return null; }
    if (!readiness) return null;
    try { for (const [tool, release] of readiness.tools) this.register(context, release.definition.sourceId, tool); } catch { return null; }
    const agentTarget: PolicyTarget = { layer: "agent", agentId: input.agentId, versionId: readiness.agentVersion.id };
    try {
      for (const tool of readiness.tools.keys()) this.seedDrafts(agentTarget, tool,
        store.transaction((tx) => activePin(tx, context, ORGANIZATION, tool) !== null));
    } catch { /* seeding is best effort; readiness below decides */ }
    let tools: GovernedToolName[];
    try { tools = [...readiness.tools].filter(([tool, release]) => store.transaction((tx) =>
      activePin(tx, context, ORGANIZATION, tool) !== null
      && activePin(tx, context, agentTarget, tool) !== null)).map(([tool]) => tool); }
    catch { return null; }
    if (!tools.length) return null;
    let identity: LocalFolderIdentity;
    try {
      const root = await snapshotProjectRoot(input.projectPath, this.fileSystem);
      identity = { kind: "local_folder", canonical_path: root.canonicalPath, dev: root.dev, ino: root.ino };
    } catch { return null; }
    if (binding && JSON.stringify(identity) !== JSON.stringify(binding.identity)) return null;
    if (this.deps.sessionBinding) {
      try { if (JSON.stringify(await this.deps.sessionBinding(input)) !== JSON.stringify(binding)) return null; } catch { return null; }
    }
    const attemptId = randomUUID(), now = this.clock().toISOString();
    const placement: ExecutionPlacementBinding = {
      schema_version: "orchestrion.execution-placement.v1", project_id: context.project_id, task_id: input.sessionId, attempt_id: attemptId,
      placement: "local_trusted", workspace: { kind: "local_folder", path: input.projectPath }, selected_by: "user", fallback: "forbidden",
      frozen: true, disclosure: "current_host_user_not_os_sandboxed", reason_code: "USER_SELECTED_PLACEMENT",
    };
    try {
      store.transaction((tx) => {
        // Folder checks awaited; recheck exact version and live policy/direct grant facts
        // before committing an attempt. No stale readiness can cross this boundary.
        const fresh = this.readiness(tx, context, input.agentId, readiness!.agentVersion.id);
        if (!fresh || tools.some(tool => toolJson(fresh.tools.get(tool)) !== toolJson(readiness!.tools.get(tool))
          || !activePin(tx, context, ORGANIZATION, tool)
          || !activePin(tx, context, agentTarget, tool))) throw new StorageError("TOOL_GRANT_NOT_READY");
        return new ExecutionAttemptRepository(tx, context).bind({
        session_id: input.sessionId, attempt_id: attemptId, agent_id: input.agentId, agent_version_id: readiness!.agentVersion.id,
        placement, workspace_identity: identity, owner: store.owner, bound_at: now,
        });
      });
    } catch { return null; }
    tools.sort((a, b) => GOVERNED_TOOLS.indexOf(a) - GOVERNED_TOOLS.indexOf(b));
    return { attemptId, tools, dynamicTools: tools.map(governedDynamicToolSpec) };
  }

  private readiness(tx: SqliteUnit, context: LocalContext, agentId: string, versionId?: string): Readiness | null {
    const agents = new AgentRepository(tx, context); agents.authorize();
    const agent = agents.get(agentId);
    if (!agent || agent.deletedAt !== null || agent.latestVersionId === null) return null;
    const agentVersion = agents.version(agentId, versionId ?? agent.latestVersionId);
    if (!agentVersion) return null;
    const tools = new Map<GovernedToolName, ReleasedTool>();
    const direct = new ToolGrantRepository(tx, context).agent(agentId, agentVersion.id);
    if (direct === null) return null;
    for (const tool of GOVERNED_TOOLS) {
      const releases = directToolReleases(tx, context, direct.grants, tool);
      const definitions = new Map(releases.map((release) => [toolJson(release.definition), release.definition]));
      if (releases.length && definitions.size === 1) tools.set(tool, { definition: releases[0].definition,
        grantHash: releases.length === 1 ? releases[0].grantHash : grantDigest(releases.map((release) => release.grantHash).sort()) });
    }
    return { agentVersion, tools };
  }

  /** The registry holds one binding per governed tool and context. The P1 policy
   * layer pins each organization floor release to that binding's direct grant and
   * anchor (any other direct grant is POLICY_BINDING_CONFLICT / TOOL_SCHEMA_DRIFT at
   * admission). Replacing the binding for a second direct grant could therefore only
   * break every session already declared against the first without admitting
   * the second, so a live binding is never unregistered or replaced here: the
   * first direct grant registered in this host process owns the slot, and a session
   * whose AgentVersion binds a different direct grant fails declaration closed
   * (native lane) before any draft is seeded or attempt bound. */
  private register(context: LocalContext, sourceId: string, tool: GovernedToolName): void {
    const connector = tool === GOVERNED_FILE_READ_TOOL ? GOVERNED_FILE_READ_CONNECTOR : GOVERNED_GIT_CONNECTOR;
    const connection = tool === GOVERNED_FILE_READ_TOOL ? GOVERNED_FILE_READ_CONNECTION : GOVERNED_GIT_CONNECTION;
    const current = this.deps.registry.get(context, connector, connection, tool);
    if (current) {
      if (current.sourceId !== sourceId) throw new StorageError("POLICY_BINDING_CONFLICT");
      return;
    }
    if (tool === GOVERNED_FILE_READ_TOOL) {
      const adapter = (request: { authority: WorkspaceAuthority; path: string; signal?: AbortSignal }): Promise<WorkspaceReadOutcome> => {
        if (!(request.authority instanceof WorkspaceAuthority)) return Promise.resolve({ ok: false, code: GOVERNED_TOOL_REASONS.hostUnavailable });
        return request.authority.read(request.path, GOVERNED_FILE_READ_MAX_BYTES, request.signal);
      };
      this.deps.registry.register(fileReadImplementation(context, sourceId, adapter)); return;
    }
    if (!this.deps.process) throw new StorageError("TOOL_IMPLEMENTATION_MISSING");
    const adapter = (request: { authority: ProcessWorkspaceAuthority; invocation: Exclude<NormalizedGitInvocation, { ok: false }>; signal?: AbortSignal }): Promise<GitProcessOutcome> => {
      if (!(request.authority instanceof ProcessWorkspaceAuthority)) return Promise.resolve({ ok: false, code: GOVERNED_TOOL_REASONS.hostUnavailable });
      return this.deps.process!.execute(request.authority, request.invocation, request.signal);
    };
    this.deps.registry.register(gitImplementation(context, sourceId, tool, adapter));
  }

  private seedDrafts(agentTarget: PolicyTarget, tool: GovernedToolName, organizationReady: boolean): void {
    const policy = this.deps.policy(), store = this.deps.store(), context = store.workspace;
    for (const target of organizationReady ? [agentTarget] : [ORGANIZATION]) {
      const exists = store.transaction((tx) => { const r = new PolicyRepository(tx, context); r.authorize(); return !!r.binding(target, tool); });
      if (exists) continue;
      policy.createDraft(this.header(policy), { target, toolName: tool, definition: defaultGovernedPolicy(tool) });
    }
  }

  release(sessionId: string): void {
    try {
      const store = this.deps.store(), now = this.clock().toISOString();
      store.transaction((tx) => {
        const attempts = new ExecutionAttemptRepository(tx, store.workspace);
        for (const open of attempts.openForSession(sessionId)) attempts.transition(open.attempt_id, open.lifecycle, "cancelled", open.revision, now);
      });
    } catch { /* an unreachable store leaves attempts to owner staleness on the next incarnation */ }
  }

  /** item/tool/call. Fresh authority, fresh policy pin, live T2 admission, revision
   * CAS in the same transaction as the admitted event, bounded read, terminal event. */
  execute(input: GovernedCallInput): Promise<DynamicToolCallResponse> {
    const execution = this.executeCall(input);
    this.executions.add(execution);
    void execution.then(() => this.executions.delete(execution), () => this.executions.delete(execution));
    return execution;
  }

  private async executeCall(input: GovernedCallInput): Promise<DynamicToolCallResponse> {
    const parsed = DynamicToolCallParamsSchema.safeParse(input.call);
    if (!parsed.success) return governedRefusal(GOVERNED_TOOL_REASONS.argumentsInvalid);
    const call = parsed.data;
    const governance = input.governance;
    if (!governance || governance.threadId !== call.threadId) return governedRefusal(GOVERNED_TOOL_REASONS.notDeclared);
    const tool = governedToolForWire(call.tool);
    let store: SqliteFoundation;
    try { store = this.deps.store(); } catch { return governedRefusal(GOVERNED_TOOL_REASONS.hostUnavailable); }
    const context = store.workspace, session = { sessionId: input.sessionId, attemptId: governance.attemptId };
    const record = (event: EventShape, tx?: SqliteUnit) => {
      const row: GovernedToolEventInput = {
        event_id: randomUUID(), session_id: input.sessionId, attempt_id: governance.attemptId, thread_id: call.threadId, turn_id: call.turnId, call_id: call.callId,
        tool_name: tool ?? GOVERNED_FILE_READ_TOOL, event_type: event.event_type, reason_code: event.reason_code, plan_hash: event.plan_hash,
        result_hash: event.result_hash, result_bytes: event.result_bytes, request_id: randomUUID(), causation_id: call.callId,
        timestamp: this.clock().toISOString(), data: { tool: tool ?? GOVERNED_FILE_READ_TOOL, call_id: call.callId, wire_tool: call.tool, path: event.path,
          ...(event.process !== undefined ? { process: event.process } : {}) },
      };
      const write = (unit: SqliteUnit) => new GovernedToolEventRepository(unit, context).insert(row, store.owner);
      if (tx) write(tx); else store.transaction(write);
    };
    const deny = (code: string, path: string | null = null, planHash: string | null = null): DynamicToolCallResponse => {
      try { record({ event_type: "denied", reason_code: code, plan_hash: planHash, result_hash: null, result_bytes: null, path }); }
      catch { /* no attempt row to hang the denial on; the refusal itself is still returned */ }
      return governedRefusal(code);
    };
    try {
      const duplicate = store.transaction((tx) => new GovernedToolEventRepository(tx, context).has(governance.attemptId, call.callId));
      if (duplicate) return governedRefusal(GOVERNED_TOOL_REASONS.duplicate);
    } catch { return governedRefusal(GOVERNED_TOOL_REASONS.hostUnavailable); }
    if (!tool || !governance.tools.includes(tool) || (call.namespace !== null && call.namespace !== undefined)) return deny(GOVERNED_TOOL_REASONS.unknownTool);
    let logicalPath: string, admittedArguments: Record<string, unknown>;
    if (tool === GOVERNED_FILE_READ_TOOL) {
      const args = FileReadArgumentsSchema.safeParse(call.arguments);
      if (!args.success) return deny(GOVERNED_TOOL_REASONS.argumentsInvalid);
      const path = normalizeFileReadPath(args.data.path);
      if (!path.ok) return deny(path.code);
      logicalPath = path.logical; admittedArguments = { path: path.relative };
    } else {
      const invocation = normalizeGitInvocation(tool, call.arguments);
      if (!invocation.ok) return deny(invocation.code);
      logicalPath = invocation.logicalPath; admittedArguments = invocation.arguments;
    }
    // 1. Fresh execution authority (EP1-A): session, AgentVersion, placement, folder, owner.
    const resolution = await new ExecutionAuthorityResolver(store, this.deps.metadata, this.fileSystem).resolve(session);
    if (!resolution.ok) return deny(resolution.code, logicalPath);
    const authority = resolution.authority;
    if (input.signal?.aborted) return deny(GOVERNED_TOOL_REASONS.cancelled, logicalPath);
    // 2. Fresh policy pin and live T2 admission (F4 receipt).
    let plan: ToolInvocationPlan, service: LocalToolInvocationService, orgPin: PolicyPin;
    try {
      const admitted = this.admit(store, authority, tool, admittedArguments, logicalPath);
      plan = admitted.plan; service = admitted.service; orgPin = admitted.orgPin;
    } catch (error) {
      return deny(error instanceof StorageError || error instanceof ToolRegistryError ? error.code : GOVERNED_TOOL_REASONS.hostUnavailable, logicalPath);
    }
    // 3. Revision CAS + owner re-check + live-readiness re-check in the same
    // transaction as the admitted event. T2's execute() (src/invocations/service.ts)
    // proves plan identity, placement, owner and anchor. Direct plans also
    // re-evaluate pinned and live organization Policy there; legacy plans do not
    // re-read Policy or direct grant state, so a legacy plan invalidated later would still
    // run if executed later. This vertical closes that window at its own call
    // site: the organization floor and agent leaf pins and the attempt's direct grant
    // are re-read here, atomically with the admitted row, and service.execute
    // follows synchronously with no await in between. Both pins must be byte-
    // identical to the ones captured at admission (review revision 8: a replaced
    // organization release is a change, not merely an absence), and the direct grant
    // must still be the plan's at the exact version T2 read when it prepared the
    // plan (review revision 9: an in-place update of the same direct grant that
    // narrows its scope and is re-approved keeps the id, so identity alone
    // admitted a plan prepared under the wider scope). This is a call-site
    // mitigation, not a T2-level structural fix; hardening execute() itself for
    // every caller is a recommended follow-up.
    try {
      store.transaction((tx) => {
        const attempts = new ExecutionAttemptRepository(tx, context), current = attempts.get(input.sessionId, governance.attemptId);
        if (!current) throw new StorageError("EXECUTION_ATTEMPT_NOT_FOUND");
        const owner = tx.get("SELECT instance_id,epoch FROM runtime_incarnation WHERE singleton=1");
        if (!owner || String(owner.instance_id) !== authority.owner.instance_id || Number(owner.epoch) !== authority.owner.epoch
          || toolJson(store.owner) !== toolJson(authority.owner)) throw new StorageError("EXECUTION_OWNER_STALE");
        if (current.revision !== authority.attempt.revision || current.lifecycle !== authority.attempt.lifecycle) throw new StorageError("EXECUTION_STATE_CHANGED");
        const floor = activePin(tx, context, ORGANIZATION, tool);
        if (floor === null || toolJson(floor) !== toolJson(orgPin)) throw new StorageError(GOVERNED_TOOL_REASONS.readinessLost);
        const grants = new ToolGrantRepository(tx, context).agent(authority.session.agentId, authority.agentVersion.id);
        const releases = grants === null ? [] : directToolReleases(tx, context, grants.grants, tool, logicalPath)
          .filter((release) => release.grantHash === plan.directGrantHash);
        if (releases.length !== 1) throw new StorageError(GOVERNED_TOOL_REASONS.readinessLost);
        if (current.lifecycle === "bound") attempts.transition(governance.attemptId, "bound", "active", current.revision, this.clock().toISOString());
        else if (current.lifecycle !== "active") throw new StorageError("EXECUTION_ATTEMPT_FINISHED");
        record({ event_type: "admitted", reason_code: null, plan_hash: plan.hash, result_hash: null, result_bytes: null, path: logicalPath }, tx);
      });
    } catch (error) {
      const code = error instanceof StorageError ? error.code : GOVERNED_TOOL_REASONS.hostUnavailable;
      return code === GOVERNED_TOOL_REASONS.readinessLost ? deny(code, logicalPath, plan.hash) : governedRefusal(code);
    }
    // 4. Bounded read through the registry's private adapter with an opaque authority.
    const finish = (event_type: "completed" | "failed" | "cancelled", reason: string | null, result: { hash: string; bytes: number } | null, process?: ProcessEvidence): boolean => {
      try {
        record({ event_type, reason_code: reason, plan_hash: plan.hash, result_hash: result?.hash ?? null, result_bytes: result?.bytes ?? null, path: logicalPath, process });
        return true;
      } catch { return false; }
    };
    let outcome: WorkspaceReadOutcome | GitProcessOutcome;
    try {
      if (!plan.directGrantLimits) throw new StorageError("TOOL_PLAN_INVALID");
      const grantSignal = AbortSignal.timeout(plan.directGrantLimits.maxRuntimeSeconds * 1000);
      const executionSignal = grantSignal && input.signal
        ? AbortSignal.any([grantSignal, input.signal])
        : grantSignal ?? input.signal;
      if (tool === GOVERNED_FILE_READ_TOOL) {
        const workspace = WorkspaceAuthority.fromExecutionAuthority(authority, this.fileSystem);
        outcome = await service.execute(plan, (adapter) => (adapter as (request: { authority: WorkspaceAuthority; path: string; signal?: AbortSignal }) => Promise<WorkspaceReadOutcome>)(
          { authority: workspace, path: plan.arguments.path as string, signal: executionSignal }));
      } else {
        const workspace = ProcessWorkspaceAuthority.fromExecutionAuthority(authority);
        const planned = normalizeGitInvocation(tool, plan.arguments);
        if (!planned.ok) throw new StorageError("TOOL_PLAN_INVALID");
        outcome = await service.execute(plan, (adapter) => (adapter as (request: { authority: ProcessWorkspaceAuthority; invocation: Exclude<NormalizedGitInvocation, { ok: false }>; signal?: AbortSignal }) => Promise<GitProcessOutcome>)(
          { authority: workspace, invocation: planned, signal: executionSignal }));
      }
    } catch (error) {
      const code = error instanceof StorageError ? error.code : GOVERNED_TOOL_REASONS.hostUnavailable;
      finish("failed", code, null);
      return governedRefusal(code);
    }
    const processEvidence = "evidence" in outcome ? outcome.evidence : undefined;
    if (input.signal?.aborted || (!outcome.ok && outcome.code === GOVERNED_TOOL_REASONS.cancelled)) {
      finish("cancelled", GOVERNED_TOOL_REASONS.cancelled, null, processEvidence); return governedRefusal(GOVERNED_TOOL_REASONS.cancelled);
    }
    if (!outcome.ok) { finish("failed", outcome.code, null, processEvidence); return governedRefusal(outcome.code); }
    // A read whose completion cannot be recorded is not reported as a success.
    // The durable result identity is the exact text returned to Codex. Process
    // stdout has its own evidence fields because status formatting deliberately
    // replaces NUL framing and quotes paths before disclosure.
    const returned = Buffer.from(outcome.text, "utf8");
    const completed = { hash: `sha256:${createHash("sha256").update(returned).digest("hex")}`, bytes: returned.byteLength };
    if (!finish("completed", null, completed, processEvidence)) return governedRefusal(GOVERNED_TOOL_REASONS.hostUnavailable);
    return { success: true, contentItems: [{ type: "inputText", text: outcome.text }] };
  }

  private admit(store: SqliteFoundation, authority: ResolvedExecutionAuthority, tool: GovernedToolName, arguments_: Record<string, unknown>,
    resource: string): { plan: ToolInvocationPlan; service: LocalToolInvocationService; orgPin: PolicyPin } {
    const context = store.workspace, registry = this.deps.registry;
    const connector = tool === GOVERNED_FILE_READ_TOOL ? GOVERNED_FILE_READ_CONNECTOR : GOVERNED_GIT_CONNECTOR;
    const connection = tool === GOVERNED_FILE_READ_TOOL ? GOVERNED_FILE_READ_CONNECTION : GOVERNED_GIT_CONNECTION;
    const definition = registry.get(context, connector, connection, tool);
    if (!definition) throw new StorageError("TOOL_IMPLEMENTATION_MISSING");
    const target: PolicyTarget = { layer: "agent", agentId: authority.session.agentId, versionId: authority.agentVersion.id };
    const orgPin = store.transaction((tx) => activePin(tx, context, ORGANIZATION, tool));
    if (!orgPin) throw new StorageError("POLICY_INACTIVE");
    const direct = store.transaction((tx) => {
      const grants = new ToolGrantRepository(tx, context).agent(authority.session.agentId, authority.agentVersion.id);
      if (grants === null) return null;
      const matches = directToolReleases(tx, context, grants.grants, tool, resource)
        .filter((release) => toolJson(release.definition) === toolJson(definition));
      if (matches.length !== 1) throw new StorageError(matches.length ? "TOOL_RESOURCE_NOT_READY" : "TOOL_INVOCATION_AUTHORITY_UNAVAILABLE");
      return matches[0];
    });
    if (!direct) throw new StorageError("TOOL_INVOCATION_AUTHORITY_UNAVAILABLE");
    const proof: InvocationHostProof = {
      context, target, targetPin: { revision: authority.agentVersion.versionNumber, hash: toolDigest(authority.agentVersion) },
      run: null, lifecycle: "active",
      connection: { connectorId: definition.connectorId, connectionId: definition.connectionId, revision: 0, status: "active", credential: null },
      placement: { kind: "local_trusted", owner: authority.owner, binding: authority.placement },
    };
    const service = registry.invocations({ store, context, policy: this.deps.policy(), resolve: () => structuredClone(proof) });
    const header = this.header(service);
    const plan = service.prepareDirect(header, { connectorId: definition.connectorId, connectionId: definition.connectionId,
      anchor: toolAnchor(definition), policy: direct.policy, arguments: arguments_ });
    if (plan.directGrantHash !== direct.grantHash) throw new StorageError("TOOL_PLAN_INVALID");
    return { plan, service, orgPin };
  }

  async shutdown(): Promise<void> {
    await this.deps.process?.shutdown();
    await Promise.allSettled([...this.executions]);
  }
}

function resourceMatches(ceiling: string, value: string): boolean {
  if (ceiling === value) return true;
  if (ceiling.endsWith("/**")) return value.startsWith(`${ceiling.slice(0, -3).replace(/\/$/, "")}/`);
  if (ceiling.endsWith("/*")) {
    const prefix = ceiling.slice(0, -2).replace(/\/$/, "");
    const suffix = value.startsWith(`${prefix}/`) ? value.slice(prefix.length + 1) : "";
    return suffix.length > 0 && !suffix.includes("/");
  }
  return false;
}

function directToolReleases(tx: SqliteUnit, context: LocalContext, grants: ToolGrant[], tool: GovernedToolName,
  resource?: string): Array<{ grant: ToolGrant; definition: ToolDefinition; grantHash: string; policy: PolicyPin }> {
  const scope = [context.org_id, context.project_id, context.principal.type, context.principal.id];
  const workspace = tx.get(`SELECT identity_json FROM local_session_tree_projects
    WHERE org_id=? AND project_id=? AND principal_type=? AND principal_id=?`, ...scope);
  const policies = new PolicyRepository(tx, context); policies.authorize();
  const result: Array<{ grant: ToolGrant; definition: ToolDefinition; grantHash: string; policy: PolicyPin }> = [];
  for (const grant of grants) {
    const requiredOutputBytes = tool === GOVERNED_FILE_READ_TOOL
      ? GOVERNED_FILE_READ_MAX_BYTES : GOVERNED_GIT_MAX_OUTPUT_BYTES;
    const requiredRuntimeSeconds = tool === GOVERNED_FILE_READ_TOOL
      ? 30 : Math.ceil(GOVERNED_GIT_TIMEOUT_MS / 1000);
    const target = grant.execution_target;
    if (!target || target.kind !== "local_workspace" || target.id !== context.project_id || target.placement !== "local_trusted"
      || !workspace || grantDigest(JSON.parse(String(workspace.identity_json))) !== target.workspace_hash
      || grant.connection !== null || grant.resource_scope.kind !== "workspace_path"
      || !grant.constraints.effects.includes("read") || grant.constraints.effects.some((effect) => effect !== "read")
      || grant.constraints.max_output_bytes < requiredOutputBytes
      || grant.constraints.max_runtime_seconds < requiredRuntimeSeconds
      || (resource !== undefined && !resourceMatches(grant.resource_scope.resource, resource))) continue;
    const contract = tx.get(`SELECT * FROM local_tool_contract_versions
      WHERE org_id=? AND project_id=? AND principal_type=? AND principal_id=? AND id=? AND contract_hash=?`,
      ...scope, grant.contract.id, grant.contract.hash);
    if (!contract || String(contract.source_namespace) !== grant.tool.source || String(contract.tool_key) !== grant.tool.key
      || String(contract.schema_hash) !== grant.constraints.argument_schema_hash) continue;
    let definition: ToolDefinition;
    try { definition = ToolDefinitionSchema.parse(JSON.parse(String(contract.contract_json))); } catch { continue; }
    if (definition.name !== tool || toolJson(toolAnchor(definition)) !== String(contract.anchor_json)) continue;
    let release;
    try { release = policies.get(grant.policy.id); } catch { continue; }
    const binding = policies.binding(release.target, tool);
    const selection = binding && policies.latest(String(binding.id));
    if (release.releaseHash !== grant.policy.hash || release.lifecycle !== "published" || release.toolName !== tool
      || toolJson(release.toolAnchor) !== toolJson(toolAnchor(definition)) || grant.approval !== null
      || !selection || selection.action === "deactivate" || selection.releaseId !== release.id) continue;
    result.push({ grant, definition, grantHash: grantDigest(grantMaterial(grant)),
      policy: { id: release.id, releaseHash: release.releaseHash, stateRevision: release.stateRevision,
        selectionSequence: selection.sequence } });
  }
  return result;
}

/** Freshly re-read on every declaration and call: the exact published release the
 * current activation selects for (target, governed tool), or null. Never cached. */
export function activePin(tx: SqliteUnit, context: LocalContext, target: PolicyTarget,
  tool: GovernedToolName = GOVERNED_FILE_READ_TOOL): PolicyPin | null {
  const r = new PolicyRepository(tx, context); r.authorize();
  const binding = r.binding(target, tool);
  if (!binding) return null;
  const selected = r.latest(String(binding.id));
  if (!selected || selected.action === "deactivate") return null;
  const release = r.get(selected.releaseId);
  if (release.lifecycle !== "published") return null;
  return { id: release.id, releaseHash: release.releaseHash, stateRevision: release.stateRevision, selectionSequence: selected.sequence };
}
