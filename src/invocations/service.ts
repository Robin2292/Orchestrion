import type { z, ZodTypeAny } from "zod";
import { LocalCommandHeaderSchema, LocalContextSchema, type LocalCommandHeader, type LocalContext } from "../shared/local-contracts";
import { createLocalCommandAdapter } from "../shared/local-command-adapter";
import { InvocationHostProofSchema, ToolInvocationRequestSchema, ToolInvocationPlanSchema,
  type ToolInvocationPlan, type ToolInvocationRequest, type ToolPlannerInput, type ToolPlannerOutputSchema,
  type ToolPlanningReview } from "../shared/tool-invocation-contracts";
import type { ToolDefinition } from "../shared/tool-registry-contracts";
import { canonical, parseCanonical, PolicyInputError } from "../shared/policy/p0-canonical";
import { evaluateLocalPolicy } from "../shared/policy/p0-evaluator";
import { meetScopes } from "../shared/policy/p0-scope";
import type { LocalPolicyService } from "../policies/service";
import { ToolRegistry, ToolRegistryError, toolAnchor, toolJson, type ToolImplementation } from "../tools/registry";
import { ToolGrantRepository, grantDigest } from "../grants/repository";
import { grantMaterial, type ToolGrant } from "../shared/tool-grant-contracts";
import { PolicyRepository } from "../policies/repository";
import { ConnectorRepository } from "../connectors/repository";
import { CredentialMetadataService } from "../services/credential-metadata";
import { AgentRepository } from "../agents/repository";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { InvocationRepository, INVOCATION_FENCE } from "./repository";
import { immutable, planHash, validateArguments } from "./planning";

/** Must authenticate the live host session and read authoritative target,
 * placement and connection state. No request DTO is forwarded to the resolver.
 * Missing workflow/delegation owners therefore fail closed instead of using
 * caller claims. Existing native Codex/PTTY are outside this governed seam. */
export type InvocationHostResolver = (tx: SqliteUnit, context: LocalContext) => unknown;
export interface ToolInvocationOptions {
  store: SqliteFoundation; context: LocalContext; policy: LocalPolicyService; resolve: InvocationHostResolver;
}
type PlanningBinding = (definition: ToolDefinition) => { review: ToolPlanningReview;
  plan(input: ToolPlannerInput): ReturnType<typeof ToolPlannerOutputSchema.parse>; adapter: ToolImplementation["adapter"] };
/** Placements an admitted plan may carry. `local_logical` is the legacy logical
 * fixture placement with no executor; `local_trusted` is the canonical EP0/EP1
 * placement whose executor is the governed file.read lane (EP1-B). Isolated,
 * remote and cloud placements stay Not Ready until their executors are wired. */
const ADMISSIBLE_PLACEMENTS: ReadonlySet<string> = new Set(["local_logical", "local_trusted"]);
const EXECUTABLE_PLACEMENTS: ReadonlySet<string> = new Set(["local_trusted"]);
const command = createLocalCommandAdapter("tool.prepare", ToolInvocationRequestSchema);

function parse<S extends ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  try {
    const bytes = toolJson(raw), result = schema.parse(parseCanonical(bytes));
    if (toolJson(result) !== bytes) throw new Error();
    return result;
  } catch { throw new StorageError("INVALID_PAYLOAD"); }
}
function safe<T>(work: () => T): T {
  try { return work(); }
  catch (e) {
    if (e instanceof StorageError) throw e;
    if (e instanceof ToolRegistryError || e instanceof PolicyInputError) throw new StorageError(e.code);
    throw new StorageError("SERVICE_UNAVAILABLE");
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

/** One bounded Local admission seam, constructed by ToolRegistry.invocations.
 * prepare never invokes an adapter. Its durable receipt is an opaque hash, not
 * authority; even exact replay must re-admit against current live owners.
 */
export class LocalToolInvocationService {
  #context: LocalContext;
  #store: SqliteFoundation;
  #policy: LocalPolicyService;
  #resolve: InvocationHostResolver;
  #registry: ToolRegistry;
  #planning: PlanningBinding;
  /** Plans this exact service instance admitted, and the subset already executed.
   * A loaded, forged or replayed plan is never executable; a prepared plan runs
   * at most once. Nothing here survives a host restart. */
  #prepared = new WeakSet<ToolInvocationPlan>();
  #executed = new WeakSet<ToolInvocationPlan>();
  #directRequests = new WeakMap<ToolInvocationPlan, { header: LocalCommandHeader; request: ToolInvocationRequest }>();
  constructor(options: ToolInvocationOptions, registry: ToolRegistry, planning: PlanningBinding) {
    this.#context = parse(LocalContextSchema, options.context);
    this.#store = options.store; this.#policy = options.policy; this.#resolve = options.resolve;
    this.#registry = registry; this.#planning = planning;
    if (toolJson(this.#policy.context) !== toolJson(this.#context)) throw new StorageError("CONTEXT_MISMATCH");
    this.read((tx) => new InvocationRepository(tx, this.#context).ensureFence());
  }
  get context() { return structuredClone(this.#context); }
  private read<T>(work: (tx: SqliteUnit) => T): T { return this.#store.transaction((tx) => safe(() => work(tx))); }
  private host(tx: SqliteUnit) {
    let host;
    try { host = parse(InvocationHostProofSchema, this.#resolve(tx, this.context)); }
    catch { throw new StorageError("TOOL_INVOCATION_AUTHORITY_UNAVAILABLE"); }
    if (toolJson(host.context) !== toolJson(this.#context) || host.target.layer === "organization"
      || (host.run && (host.run.project_id !== this.#context.project_id
        || ((host.target.layer === "workflow" || host.target.layer === "node") && host.run.workflow_id !== host.target.workflowId))))
      throw new StorageError("TOOL_INVOCATION_AUTHORITY_UNAVAILABLE");
    if (host.lifecycle !== "active") throw new StorageError("TOOL_TARGET_NOT_READY");
    if (host.target.layer === "agent") {
      const agents = new AgentRepository(tx, this.#context), current = agents.get(host.target.agentId);
      if (!current || current.deletedAt || !agents.version(host.target.agentId, host.target.versionId))
        throw new StorageError("TOOL_TARGET_NOT_READY");
    }
    if (host.connection.status !== "active") throw new StorageError("TOOL_CONNECTION_NOT_READY");
    const connectors = new ConnectorRepository(tx, this.#context); connectors.authorize();
    try {
      connectors.get(host.connection.connectorId);
      // C0 connector records are configuration only. A host claim must never
      // promote one into executable authority.
      throw new StorageError("TOOL_CONNECTION_NOT_READY");
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "CONNECTOR_NOT_FOUND") throw error;
    }
    if (host.connection.credential) {
      try {
        new CredentialMetadataService(tx, { org_id: this.#context.org_id, principal: this.#context.principal })
          .requireActive(host.connection.credential);
      } catch { throw new StorageError("TOOL_CREDENTIAL_NOT_READY"); }
    }
    if (toolJson(host.placement.owner) !== toolJson(this.#store.owner)) throw new StorageError("RUNTIME_OWNER_MISMATCH");
    return host;
  }
  authority() {
    return this.read((tx) => {
      const r = new InvocationRepository(tx, this.#context), host = this.host(tx);
      return { context: this.context, runtime_owner: this.#store.owner, expected: r.pin(), run: host.run };
    });
  }
  private buildDirect(tx: SqliteUnit, h: LocalCommandHeader, request: ToolInvocationRequest): ToolInvocationPlan {
    const host = this.host(tx);
    const valid = command.validate(toolJson({ ...h, command: "tool.prepare", payload: request }), {
      context: this.context, runtime_owner: this.#store.owner, expected: h.expected, run: host.run,
    });
    if (!valid.ok) throw new StorageError(valid.error.code);
    if (host.target.layer !== "agent" || host.connection.connectorId !== request.connectorId
      || host.connection.connectionId !== request.connectionId) throw new StorageError("TOOL_INVOCATION_AUTHORITY_UNAVAILABLE");
    if (host.lifecycle !== "active" || !ADMISSIBLE_PLACEMENTS.has(host.placement.kind)
      || host.placement.kind !== "local_trusted" || !("binding" in host.placement)) throw new StorageError("TOOL_PLACEMENT_NOT_READY");
    const definition = this.#registry.get(this.context, request.connectorId, request.connectionId, request.anchor.tool_name);
    if (!definition) throw new StorageError("TOOL_IMPLEMENTATION_MISSING");
    if (toolJson(toolAnchor(definition)) !== toolJson(request.anchor)) throw new StorageError("TOOL_SCHEMA_DRIFT");
    const contract = tx.get(`SELECT source_namespace,tool_key,schema_hash FROM local_tool_contract_versions
      WHERE org_id=? AND project_id=? AND principal_type=? AND principal_id=? AND id=? AND contract_hash=?`,
      this.#context.org_id, this.#context.project_id, this.#context.principal.type, this.#context.principal.id,
      request.anchor.tool_contract_version_id, request.anchor.tool_contract_hash);
    if (!contract) throw new StorageError("TOOL_SCHEMA_DRIFT");
    const grants = new ToolGrantRepository(tx, this.#context).agent(host.target.agentId, host.target.versionId);
    if (grants === null) throw new StorageError("TOOL_INVOCATION_AUTHORITY_UNAVAILABLE");
    const planning = this.#planning(definition);
    validateArguments(definition.parameters, request.arguments);
    const repository = new PolicyRepository(tx, this.#context); repository.authorize();
    const organizationBinding = repository.binding({ layer: "organization" }, definition.name);
    const selected = organizationBinding && repository.latest(String(organizationBinding.id));
    if (!selected || selected.action === "deactivate") throw new StorageError("POLICY_INACTIVE");
    const organization = repository.get(selected.releaseId);
    if (organization.lifecycle !== "published" || organization.target.layer !== "organization"
      || organization.toolName !== definition.name || toolJson(organization.toolAnchor) !== toolJson(request.anchor))
      throw new StorageError("TOOL_POLICY_DENIED");
    const candidates: Array<{ grant: ToolGrant; plan: ToolInvocationPlan }> = [];
    for (const grant of grants.grants) {
      if (grant.contract.id !== request.anchor.tool_contract_version_id || grant.contract.hash !== request.anchor.tool_contract_hash
        || grant.constraints.argument_schema_hash !== String(contract.schema_hash)
        || grant.tool.source !== String(contract.source_namespace) || grant.tool.key !== String(contract.tool_key)
        || grant.execution_target?.kind !== "local_workspace" || grant.execution_target.id !== this.#context.project_id
        || grant.execution_target.placement !== "local_trusted" || grant.connection !== null
        || grant.resource_scope.kind !== "workspace_path" || !grant.constraints.effects.includes("read")
        || grant.constraints.effects.some((effect: string) => effect !== "read")) continue;
      let release;
      try { release = repository.get(grant.policy.id); } catch { continue; }
      const releaseBinding = repository.binding(release.target, definition.name);
      const releaseSelection = releaseBinding && repository.latest(String(releaseBinding.id));
      if (release.releaseHash !== grant.policy.hash || release.lifecycle !== "published" || release.toolName !== definition.name
        || toolJson(release.toolAnchor) !== toolJson(request.anchor) || request.policy.id !== release.id
        || request.policy.releaseHash !== release.releaseHash || request.policy.stateRevision !== release.stateRevision
        || !releaseSelection || releaseSelection.action === "deactivate" || releaseSelection.releaseId !== release.id
        || request.policy.selectionSequence !== releaseSelection.sequence
        || grant.approval !== null || release.definition.approval_required) continue;
      const root = grant.resource_scope.resource.endsWith("/**")
        ? grant.resource_scope.resource.slice(0, -3) || "/"
        : grant.resource_scope.resource;
      let scope, prepared;
      let decision: ReturnType<typeof evaluateLocalPolicy>;
      try {
        scope = meetScopes(meetScopes(release.definition.scope, organization.definition.scope), { workspace_dir: root });
        prepared = planning.plan({ arguments: request.arguments, scope });
        validateArguments(definition.parameters, prepared.arguments);
        decision = evaluateLocalPolicy(toolJson({ profile: "canonical_resource_rules@1", path_semantics: "posix_case_sensitive",
          upstream_scope: scope, approval_required: false,
          policies: [organization, release].map((policy, index) => ({ ...policy.definition, policy_key: `layer-${index}` })),
          claims: prepared.claims }));
        if (!["workspace_dir", "base_path"].some((key) => Object.hasOwn(decision.effective_scope, key))) continue;
      } catch { continue; }
      if (decision.outcome !== "allow" || prepared.claims.some((claim) => claim.mode !== "read"
        || claim.type !== grant.resource_scope.kind || !resourceMatches(grant.resource_scope.resource, claim.value))) continue;
      const claims = [...new Map(prepared.claims.map((claim) => [canonical(claim), claim])).entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, claim]) => claim);
      const directGrantHash = grantDigest(grantMaterial(grant));
      const material = { schemaVersion: "orchestrion.local.tool-plan.v2" as const, authority: "direct_tool_grants@1" as const,
        context: this.context, target: host.target, targetPin: host.targetPin, run: host.run, connection: host.connection,
        placement: host.placement, anchor: request.anchor, review: planning.review,
        policies: [{ id: release.id, releaseHash: release.releaseHash,
          stateRevision: release.stateRevision, selectionSequence: request.policy.selectionSequence, target: release.target, anchor: release.toolAnchor },
          { id: organization.id, releaseHash: organization.releaseHash, stateRevision: organization.stateRevision,
            selectionSequence: selected.sequence, target: organization.target, anchor: organization.toolAnchor }],
        arguments: prepared.arguments, claims, scope: decision.effective_scope, directGrantHash,
        directGrantLimits: { maxOutputBytes: grant.constraints.max_output_bytes,
          maxRuntimeSeconds: grant.constraints.max_runtime_seconds } };
      candidates.push({ grant, plan: immutable(parse(ToolInvocationPlanSchema, { ...material, hash: planHash(material) })) });
    }
    if (candidates.length !== 1) throw new StorageError(candidates.length ? "TOOL_RESOURCE_NOT_READY" : "TOOL_INVOCATION_AUTHORITY_UNAVAILABLE");
    return candidates[0].plan;
  }
  prepareDirect(header: LocalCommandHeader, raw: unknown): ToolInvocationPlan {
    const h = parse(LocalCommandHeaderSchema, header), request = parse(ToolInvocationRequestSchema, raw);
    const plan = this.read((tx) => this.buildDirect(tx, h, request));
    const receipt = this.#store.commit({ trustedContext: this.context, header: h, command: "tool.prepare",
      resourceKey: INVOCATION_FENCE, canonicalContent: toolJson(request), nextHash: plan.hash }, (tx) => safe(() => {
      const final = this.buildDirect(tx, h, request);
      if (toolJson(final) !== toolJson(plan)) throw new StorageError("TOOL_PLAN_NONDETERMINISTIC");
      return final.hash;
    }));
    if (receipt.resultRef !== plan.hash) throw new StorageError("REVISION_CONFLICT");
    this.#prepared.add(plan);
    this.#directRequests.set(plan, { header: h, request });
    return plan;
  }
  /** The only route to a registered adapter. `plan` must be the frozen object this
   * service returned from prepare() in this process, carry an executable canonical
   * placement, still match the live registry anchor and review, and not have run
   * before. The caller supplies the host-owned authority (for example a
   * WorkspaceAuthority) through `run`; no credential, SQL unit or host object is
   * injected here. Direct plans recheck pinned and live organization Policy
   * immediately before dispatch; callers treat the result as data, never a grant. */
  execute<R>(plan: ToolInvocationPlan, run: (adapter: ToolImplementation["adapter"], plan: ToolInvocationPlan) => R): R {
    if (!this.#prepared.has(plan)) throw new StorageError("TOOL_PLAN_INVALID");
    if (this.#executed.has(plan)) throw new StorageError("TOOL_CALL_DUPLICATE");
    const { hash, ...material } = plan;
    if (toolJson(this.context) !== toolJson(plan.context) || planHash(material) !== hash) throw new StorageError("TOOL_PLAN_INVALID");
    if (!EXECUTABLE_PLACEMENTS.has(plan.placement.kind) || !("binding" in plan.placement)
      || toolJson(plan.placement.owner) !== toolJson(this.#store.owner)) throw new StorageError("TOOL_PLACEMENT_NOT_READY");
    if (plan.review.effect !== "read_only" || plan.claims.some((c) => c.mode !== "read")) throw new StorageError("TOOL_PROTECTED_NOT_READY");
    const definition = safe(() => this.#registry.get(this.context, plan.connection.connectorId, plan.connection.connectionId, plan.anchor.tool_name));
    if (!definition) throw new StorageError("TOOL_IMPLEMENTATION_MISSING");
    if (toolJson(toolAnchor(definition)) !== toolJson(plan.anchor)) throw new StorageError("TOOL_SCHEMA_DRIFT");
    const binding = safe(() => this.#planning(definition));
    if (toolJson(binding.review) !== toolJson(plan.review)) throw new StorageError("TOOL_SCHEMA_DRIFT");
    const input = this.#directRequests.get(plan);
    if (!input) throw new StorageError("TOOL_PLAN_INVALID");
    const current = this.read((tx) => this.buildDirect(tx, input.header, input.request));
    if (toolJson(current) !== toolJson(plan)) throw new StorageError("TOOL_CALL_READINESS_LOST");
    this.#executed.add(plan);
    return run(binding.adapter, plan);
  }
}
