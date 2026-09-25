import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalIdSchema, LocalHashSchema, LocalContextSchema, LocalCommandHeaderSchema, type LocalContext, type LocalCommandHeader } from "../shared/local-contracts";
import { ToolScopeSchema, type ToolScope } from "../shared/tool-scope";
import { PolicyDraftSchema, PolicyIdSchema, PolicyTransitionSchema, PolicySelectionSchema, PolicyPreviewSchema,
  PolicyTargetSchema, PolicyActiveSummaryInputSchema, PolicyActiveSummarySchema,
  type PolicyTarget, type PolicyDefinition, type PolicyRelease } from "../shared/policy/p1-contracts";
import { canonical, parseCanonical, PolicyInputError, type Scope, type Json } from "../shared/policy/p0-canonical";
import { narrowScope, validateScope } from "../shared/policy/p0-scope";
import { evaluateLocalPolicy } from "../shared/policy/p0-evaluator";
import { AgentRepository } from "../agents/repository";
import { ToolRegistry, ToolRegistryError, toolAnchor, toolDigest, toolJson } from "../tools/registry";
import type { ToolPolicySource } from "../shared/tool-policy-source";
import { ToolPolicyMetadataSchema, ToolDefinitionSchema } from "../shared/tool-registry-contracts";
import { P0EvaluationSchema } from "../shared/policy/p0-evaluator";
import { InvocationPolicyPinSchema, type ToolInvocationRequest } from "../shared/tool-invocation-contracts";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { PolicyRepository, POLICY_FENCE, policyHash, releaseHash } from "./repository";
import { GOVERNED_LOGICAL_WORKSPACE_ROOT } from "../shared/governed-tool-contracts";
import type { LocalSourcePublicationService, PublishedSourcePolicyPreflight } from "../sources/service";

/** Host-only dependency. Must read released target ownership/ancestry and its T0
 * binding from authoritative storage in this unit; never forward renderer input.
 * Missing host proof fails closed. No workflow persistence/runtime is invented here.
 */
export type PolicyHostResolver = (tx: SqliteUnit, context: LocalContext, target: PolicyTarget, toolName: string) => {
  context: LocalContext; connectorId: string; connectionId: string; lineage: PolicyTarget[]; scope: ToolScope; approvalRequired: boolean;
} | null;
const proofSchema = z.object({ context: LocalContextSchema, connectorId: LocalIdSchema, connectionId: LocalIdSchema, lineage: z.array(PolicyTargetSchema).min(1).max(4),
  scope: ToolScopeSchema, approvalRequired: z.boolean() }).strict();
const order = { organization: 0, workflow: 1, agent: 2, node: 3 };

/** Host-only configuration binding; no adapter or ToolRegistry entry is made. */
export function publishedSourcePolicyName(sourceId:string,key:string):string {
  return `source:${sourceId}:${toolDigest(key).slice(7)}`;
}
export interface PublishedSourcePolicyHostBinding {
  readonly toolName:string;
  prepare():void;
  clear():void;
  revalidate(tx:SqliteUnit):ReturnType<LocalSourcePublicationService["revalidatePolicyContract"]>;
}
/** Supplied by a trusted grant/Assignment owner, never by renderer authority. */
export const PublishedSourcePolicyPinSchema=z.object({ sourceId:z.string().uuid(),releaseId:z.string().uuid(),
  contractId:LocalIdSchema,contractHash:LocalHashSchema,schemaHash:LocalHashSchema }).strict();

export class LocalPolicyService {
  #context: LocalContext;
  constructor(private readonly store: SqliteFoundation, context: LocalContext, private readonly resolve: PolicyHostResolver,
    private readonly registry: ToolRegistry, private readonly clock = () => new Date(),
    private readonly sourceBinding?:PublishedSourcePolicyHostBinding) {
    this.#context = LocalContextSchema.parse(context);
    this.read((r) => r.ensureFence());
  }
  get context() { return structuredClone(this.#context); }
  private read<T>(work: (r: PolicyRepository, tx: SqliteUnit) => T, sourceProof=false): T {
    if (sourceProof) this.sourceBinding?.prepare();
    try { return this.store.transaction((tx) => { const r = new PolicyRepository(tx, this.context); r.authorize();
      try { return work(r,tx); }
      catch (e) { if (e instanceof PolicyInputError || e instanceof ToolRegistryError) throw new StorageError(e.code); throw e; } }); }
    finally { if (sourceProof) this.sourceBinding?.clear(); }
  }
  authority() { return { context: this.context, runtime_owner: this.store.owner, expected: this.read((r) => r.pin()), run: null }; }
  private parse<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
    // T1's raw-graph guard delegates canonical bytes to integrated P0/A0.
    let bytes: string;
    try { bytes = toolJson(raw); } catch { throw new StorageError("INVALID_PAYLOAD"); }
    const value = schema.parse(parseCanonical(bytes));
    if (canonical(value) !== bytes) throw new StorageError("INVALID_PAYLOAD");
    return value;
  }
  private mutate(header: LocalCommandHeader, command: string, payload: unknown,
    work: (r: PolicyRepository, tx: SqliteUnit) => string, approve = false, sourceProof = true) {
    const h = LocalCommandHeaderSchema.parse(header);
    if (h.run !== null) throw new StorageError("INVALID_PAYLOAD");
    this.read((r) => r.authorize(true, approve));
    const bytes = canonical(payload as Json);
    const prior=this.sourceBinding ? this.read((_r,tx)=>!!tx.get(`SELECT 1 FROM command_commits
      WHERE org_id=? AND project_id=? AND principal_type=? AND principal_id=? AND command=? AND idempotency_key=?`,
      this.context.org_id,this.context.project_id,this.context.principal.type,this.context.principal.id,command,h.idempotency_key)) : false;
    if (!prior && sourceProof) this.sourceBinding?.prepare();
    let result:ReturnType<SqliteFoundation["commit"]>;
    try { result = this.store.commit({ trustedContext: this.context, header: h, command, resourceKey: POLICY_FENCE,
      canonicalContent: bytes, nextHash: policyHash(parseCanonical(bytes)) }, (tx) => {
        const r = new PolicyRepository(tx, this.context); r.authorize(true, approve);
        try { return work(r,tx); }
        catch (e) { if (e instanceof PolicyInputError || e instanceof ToolRegistryError) throw new StorageError(e.code); throw e; }
      }); }
    finally { this.sourceBinding?.clear(); }
    // Opaque durable result only: exact replay stays identical after later changes.
    return { resultRef: result.resultRef };
  }
  private host(tx: SqliteUnit, target: PolicyTarget, toolName: string) {
    if (this.sourceBinding) {
      if (toolName!==this.sourceBinding.toolName || (target.layer!=="organization" && target.layer!=="agent"))
        throw new StorageError("POLICY_AUTHORITY_UNAVAILABLE");
      const source=this.sourceBinding.revalidate(tx);
      if (target.layer==="agent") {
        const agents=new AgentRepository(tx,this.context); agents.authorize();
        const agent=agents.get(target.agentId);
        if (!agent || agent.deletedAt || !agents.version(target.agentId,target.versionId))
          throw new StorageError("AGENT_VERSION_NOT_FOUND");
      }
      const sourceScope:ToolScope=source.adapterKind==="declarative_http_get" && source.httpEndpointResource
        ? {http_endpoint:source.httpEndpointResource} : {workspace_dir:GOVERNED_LOGICAL_WORKSPACE_ROOT};
      return { context:this.context,connectorId:source.connectorId,connectionId:source.connectionId,
        lineage:target.layer==="organization" ? [{ layer:"organization" as const }] : [{ layer:"organization" as const },target],
        scope:sourceScope,approvalRequired:false,
        anchor:source.anchor,sourceEvidence:source };
    }
    const p = proofSchema.safeParse(this.resolve(tx,this.context,structuredClone(target),toolName));
    if (!p.success || canonical(p.data.context) !== canonical(this.context)) throw new StorageError("POLICY_AUTHORITY_UNAVAILABLE");
    const lineage = p.data.lineage;
    if (lineage[0].layer !== "organization" || canonical(lineage.at(-1)!) !== canonical(target)
      || lineage.some((v,i) => i > 0 && order[v.layer] <= order[lineage[i-1].layer])
      || (target.layer === "node" && !lineage.some((v) => v.layer === "workflow" && v.workflowId === target.workflowId)))
      throw new StorageError("POLICY_AUTHORITY_UNAVAILABLE");
    for (const item of lineage) if (item.layer === "agent") {
      const agents = new AgentRepository(tx,this.context); agents.authorize();
      const agent = agents.get(item.agentId);
      if (!agent || agent.deletedAt) throw new StorageError("AGENT_NOT_FOUND");
      if (!agents.version(item.agentId,item.versionId)) throw new StorageError("AGENT_VERSION_NOT_FOUND");
    }
    const registered = this.registry.get(this.context,p.data.connectorId,p.data.connectionId,toolName);
    if (!registered) throw new StorageError("TOOL_IMPLEMENTATION_MISSING");
    return { ...p.data, anchor: toolAnchor(registered),sourceEvidence:null };
  }
  private proof(r: PolicyRepository, tx: SqliteUnit, target: PolicyTarget, toolName: string,
    definition: PolicyDefinition, frozen?: ToolScope, anchor?: PolicyRelease["toolAnchor"]) {
    const host = this.host(tx,target,toolName);
    if (anchor && canonical(anchor) !== canonical(host.anchor)) throw new StorageError("TOOL_SCHEMA_DRIFT");
    let scope = host.scope;
    if (frozen) scope = narrowScope(scope,frozen);
    validateScope(scope); narrowScope(scope,definition.scope);
    const policies: PolicyDefinition[] = [];
    const releases = [];
    let effective = scope, approvalRequired = host.approvalRequired;
    for (const ancestor of host.lineage.slice(0,-1)) {
      const b = r.binding(ancestor,toolName), selected = b ? r.latest(String(b.id)) : null;
      if (!selected) {
        if (ancestor.layer === "organization") throw new StorageError("POLICY_AUTHORITY_UNAVAILABLE");
        continue;
      }
      if (selected.action === "deactivate") throw new StorageError("POLICY_INACTIVE");
      const parent = r.get(selected.releaseId);
      if (parent.lifecycle !== "published") throw new StorageError("POLICY_REVOKED");
      // Parent's own current host binding must still be valid too.
      const parentHost = this.host(tx,parent.target,toolName);
      if (canonical(parentHost.anchor) !== canonical(parent.toolAnchor)) throw new StorageError("TOOL_SCHEMA_DRIFT");
      const parentScope = narrowScope(parentHost.scope,parent.scope);
      narrowScope(parentScope,parent.definition.scope);
      effective = narrowScope(effective,parent.definition.scope);
      policies.push(parent.definition); approvalRequired ||= parentHost.approvalRequired;
      releases.push({ id: parent.id, releaseHash: parent.releaseHash, stateRevision: parent.stateRevision,
        selectionSequence: selected.sequence, target: parent.target, anchor: parent.toolAnchor });
    }
    const candidateScope = narrowScope(effective,definition.scope);
    for (const rule of definition.rules) if (rule.decision !== "deny") {
      const roots = ["workspace_dir", "base_path", "http_endpoint"].filter((key) => Object.hasOwn(candidateScope,key));
      if (!roots.length) throw new StorageError("POLICY_AUTHORITY_UNAVAILABLE");
      for (const key of roots) narrowScope({ [key]:candidateScope[key] },{ [key]:rule.matcher.value });
    }
    // Keys identify layers for P0's unique-key rule; immutable original keys remain in storage.
    return { scope: host.scope, anchor: host.anchor, connectorId:host.connectorId, connectionId:host.connectionId,
      upstream: scope, approvalRequired, lineage: host.lineage, releases,sourceEvidence:host.sourceEvidence,
      policies: [...policies,definition].map((p,i) => ({ ...p, policy_key: `layer-${i}` })) };
  }
  createDraft(header: LocalCommandHeader, raw: unknown) {
    const p = this.parse(PolicyDraftSchema,raw);
    return this.mutate(header,"policy.draft",p,(r,tx) => {
      const proof = this.proof(r,tx,p.target,p.toolName,p.definition);
      const bindingId = r.createBinding(p.target,p.toolName);
      const material = { schemaVersion: "orchestrion.local.policy.v2" as const, id: randomUUID(), bindingId,
        revision: r.nextRevision(bindingId), ...p, scope: proof.scope, toolAnchor: proof.anchor, createdAt: this.clock().toISOString() };
      r.insert({ ...material, releaseHash: releaseHash(material,this.context), lifecycle: "draft", stateRevision: 0 }); return material.id;
    });
  }
  private pinned(r: PolicyRepository, p: { id: string; releaseHash: string; stateRevision: number }) {
    const release = r.get(p.id);
    if (release.releaseHash !== p.releaseHash) throw new StorageError("POLICY_HASH_CONFLICT");
    if (release.stateRevision !== p.stateRevision) throw new StorageError("POLICY_STATE_CONFLICT");
    return release;
  }
  transition(header: LocalCommandHeader, raw: unknown) {
    const p = this.parse(PolicyTransitionSchema,raw);
    return this.mutate(header,"policy.transition",p,(r,tx) => {
      const release = this.pinned(r,p);
      if (p.action === "revoke") {
        if (release.lifecycle === "revoked") return release.id;
      } else {
        if (release.lifecycle !== (p.action === "review" ? "draft" : "reviewed")) throw new StorageError("POLICY_STATE_CONFLICT");
        if (r.newerPublished(release)) throw new StorageError("POLICY_RELEASE_STALE");
        this.proof(r,tx,release.target,release.toolName,release.definition,release.scope,release.toolAnchor);
      }
      r.transition(release,p.action === "review" ? "reviewed" : p.action === "publish" ? "published" : "revoked",this.clock().toISOString()); return release.id;
    },true,p.action!=="revoke");
  }
  select(header: LocalCommandHeader, raw: unknown) {
    const p = this.parse(PolicySelectionSchema,raw);
    return this.mutate(header,"policy.select",p,(r,tx) => {
      const release = this.pinned(r,p), current = r.latest(release.bindingId);
      if ((current?.sequence ?? 0) !== p.expectedSequence) throw new StorageError("REVISION_CONFLICT");
      if (p.action === "deactivate") {
        if (!current || current.releaseId !== release.id) throw new StorageError("POLICY_BINDING_CONFLICT");
        if (current.action === "deactivate") return current.id;
      } else {
        if (release.lifecycle !== "published") throw new StorageError("POLICY_REVOKED");
        if (p.action === "rollback" && (!r.wasActive(release.bindingId,release.id) || current?.action === "deactivate"))
          throw new StorageError("POLICY_ROLLBACK_INVALID");
        if (p.action === "activate" && r.newerPublished(release)) throw new StorageError("POLICY_RELEASE_STALE");
        this.proof(r,tx,release.target,release.toolName,release.definition,release.scope,release.toolAnchor);
        if (current?.releaseId === release.id && current.action !== "deactivate") return current.id;
      }
      return r.select(release,p.action,p.expectedSequence+1,this.clock().toISOString());
    },true,p.action!=="deactivate");
  }
  get(raw: unknown) { const p = this.parse(PolicyIdSchema,raw); return this.read((r) => r.get(p.id)); }
  list() { return this.read((r) => r.list()); }
  selection(raw: unknown) { const p = this.parse(PolicyIdSchema,raw); return this.read((r) => r.latest(r.get(p.id).bindingId)); }
  /** Host-only authoring projection. It exposes configuration evidence, never an
   * admission token, and deliberately reuses the exact P1 proof path. */
  authoring(raw: unknown) {
    const p = this.parse(PolicyIdSchema,raw);
    return this.read((r,tx) => {
      const release = r.get(p.id), selection = r.latest(release.bindingId);
      const proof = this.proof(r,tx,release.target,release.toolName,release.definition,release.scope,release.toolAnchor);
      const applicable = proof.releases.map((item) => r.get(item.id));
      const upstreamScope = applicable.reduce((value,item) => narrowScope(value,item.definition.scope),proof.upstream);
      const effectiveScope = narrowScope(upstreamScope,release.definition.scope);
      const baseline = selection && selection.action !== "deactivate" ? r.get(selection.releaseId) : null;
      return {
        release, selection, baseline, upstreamRelease: applicable.at(-1) ?? null,
        upstreamScope, effectiveScope, applicable: [...applicable,release],
        approvalRequired: proof.approvalRequired || proof.policies.some((definition) => definition.approval_required),
        stale: release.lifecycle !== "published" && r.newerPublished(release), grantsAuthority: false as const,
      };
    },true);
  }
  /** T2 host-only read within its F4 transaction. Preview and model metadata are
   * deliberately insufficient: require the exact active immutable release and
   * re-prove every ancestor, binding and live registry anchor before planning. */
  admission(tx: SqliteUnit, targetRaw: unknown, definitionRaw: unknown, pinRaw: ToolInvocationRequest["policy"]) {
    // A published Source Policy is configuration evidence only. The executable
    // admission path still requires a registered, reviewed implementation.
    if (this.sourceBinding) throw new StorageError("TOOL_IMPLEMENTATION_MISSING");
    const target = this.parse(PolicyTargetSchema, targetRaw), definition = this.parse(ToolDefinitionSchema, definitionRaw);
    const pin = this.parse(InvocationPolicyPinSchema, pinRaw), r = new PolicyRepository(tx, this.context);
    r.authorize();
    if (canonical(definition.context) !== canonical(this.context)) throw new StorageError("CONTEXT_MISMATCH");
    const release = this.pinned(r, pin), selected = r.latest(release.bindingId);
    if (canonical(release.target) !== canonical(target) || release.toolName !== definition.name)
      throw new StorageError("POLICY_BINDING_CONFLICT");
    if (release.lifecycle !== "published") throw new StorageError("POLICY_REVOKED");
    if (!selected || selected.action === "deactivate") throw new StorageError("POLICY_INACTIVE");
    if (selected.releaseId !== release.id || selected.sequence !== pin.selectionSequence) throw new StorageError("POLICY_RELEASE_STALE");
    const proof = this.proof(r, tx, target, definition.name, release.definition, release.scope, release.toolAnchor);
    const anchor = toolAnchor(definition);
    if (canonical(proof.anchor) !== canonical(anchor) || proof.releases.some((p) => canonical(p.anchor) !== canonical(anchor)))
      throw new StorageError("POLICY_BINDING_CONFLICT");
    return { ...proof, releases: [...proof.releases, { ...pin, target, anchor }] };
  }
  /** D2E3's read-only entry point. The caller owns the single fenced SQLite
   * transaction and must consume this result there; it is never a bearer grant.
   * P1's existing lineage and P0's deny/approval evaluator remain authoritative. */
  revalidatePublishedSource(tx:SqliteUnit,targetRaw:unknown,pinRaw:unknown,claimsRaw:unknown,sourcePinRaw:unknown) {
    if (!this.sourceBinding) throw new StorageError("POLICY_AUTHORITY_UNAVAILABLE");
    try { return this.revalidatePreparedPublishedSource(tx,targetRaw,pinRaw,claimsRaw,sourcePinRaw); }
    finally { this.sourceBinding?.clear(); }
  }
  /** Must be called synchronously after any await and before the caller's
   * transaction; no in-transaction discovery or stale cached preflight. */
  preparePublishedSource() {
    if (!this.sourceBinding) throw new StorageError("POLICY_AUTHORITY_UNAVAILABLE");
    this.sourceBinding.prepare();
  }
  private revalidatePreparedPublishedSource(tx:SqliteUnit,targetRaw:unknown,pinRaw:unknown,claimsRaw:unknown,sourcePinRaw:unknown) {
    if (!this.sourceBinding) throw new StorageError("POLICY_AUTHORITY_UNAVAILABLE");
    const target=this.parse(PolicyTargetSchema,targetRaw);
    const pin=this.parse(InvocationPolicyPinSchema,pinRaw);
    const claims=this.parse(P0EvaluationSchema.innerType().shape.claims,claimsRaw);
    const sourcePin=this.parse(PublishedSourcePolicyPinSchema,sourcePinRaw);
    const r=new PolicyRepository(tx,this.context); r.authorize();
    const release=this.pinned(r,pin),selected=r.latest(release.bindingId);
    if (canonical(release.target)!==canonical(target) || release.toolName!==this.sourceBinding.toolName)
      throw new StorageError("POLICY_BINDING_CONFLICT");
    if (release.lifecycle!=="published") throw new StorageError("POLICY_REVOKED");
    if (!selected || selected.action==="deactivate") throw new StorageError("POLICY_INACTIVE");
    if (selected.releaseId!==release.id || selected.sequence!==pin.selectionSequence)
      throw new StorageError("POLICY_RELEASE_STALE");
    const proof=this.proof(r,tx,target,release.toolName,release.definition,release.scope,release.toolAnchor);
    const live=proof.sourceEvidence;
    if (!live || live.sourceId!==sourcePin.sourceId || live.sourceReleaseId!==sourcePin.releaseId
      || live.contractId!==sourcePin.contractId || live.contractHash!==sourcePin.contractHash
      || live.schemaHash!==sourcePin.schemaHash) throw new StorageError("SOURCE_DRIFT");
    const decision=evaluateLocalPolicy(canonical({ profile:"canonical_resource_rules@1",
      path_semantics:"posix_case_sensitive",upstream_scope:proof.upstream,
      approval_required:proof.approvalRequired,policies:proof.policies,claims }));
    return { source:proof.sourceEvidence,policy:{ id:release.id,releaseHash:release.releaseHash,
      stateRevision:release.stateRevision,selectionSequence:selected.sequence },
      ancestors:proof.releases,decision,executionReady:false as const,grantsAuthority:false as const };
  }
  /** Host-composed configuration evidence for management UI. This does not
   * evaluate an invocation claim and cannot be consumed as admission. */
  activeSummary(raw: unknown) {
    const p = this.parse(PolicyActiveSummaryInputSchema,raw);
    return this.read((r,tx) => {
      const binding = r.binding(p.target,p.toolName), selected = binding ? r.latest(String(binding.id)) : null;
      if (!selected || selected.action === "deactivate") return null;
      const release = r.get(selected.releaseId);
      if (release.lifecycle !== "published") return null;
      if (canonical(release.toolAnchor) !== canonical(p.toolAnchor)) return null;
      const proof = this.proof(r,tx,p.target,p.toolName,release.definition,release.scope,release.toolAnchor);
      if (proof.connectorId !== p.connectorId || proof.connectionId !== p.connectionId
        || canonical(proof.anchor) !== canonical(p.toolAnchor)) return null;
      const effectiveScope = proof.policies.reduce((scope,definition) => narrowScope(scope,definition.scope),proof.upstream);
      return PolicyActiveSummarySchema.parse({
        approvalRequired: proof.approvalRequired || proof.policies.some((definition) => definition.approval_required),
        effectiveScope,
      });
    },true);
  }
  /** Preview/simulation are read-only configuration evidence, never admission. */
  preview(raw: unknown) {
    const p = this.parse(PolicyPreviewSchema,raw);
    return this.read((r,tx) => {
      const release = this.pinned(r,p);
      if (release.lifecycle === "revoked") throw new StorageError("POLICY_REVOKED");
      const proof = this.proof(r,tx,release.target,release.toolName,release.definition,release.scope,release.toolAnchor);
      return { releaseId: release.id, releaseHash: release.releaseHash, stateRevision: release.stateRevision,
        selection: r.latest(release.bindingId), decision: evaluateLocalPolicy(canonical({ profile: "canonical_resource_rules@1",
          path_semantics: "posix_case_sensitive", upstream_scope: proof.upstream, approval_required: proof.approvalRequired,
          policies: proof.policies, claims: p.claims })), grantsAuthority: false as const };
    },true);
  }
  /** Host composition for T1's existing read-only interface. Target and fixtures
   * come from the host, never model-selected authority. T1 still evaluates P0.
   */
  policySource(targetRaw: unknown, claimsRaw: unknown): ToolPolicySource {
    if (this.sourceBinding) throw new StorageError("TOOL_IMPLEMENTATION_MISSING");
    const target = this.parse(PolicyTargetSchema,targetRaw);
    const claims = this.parse(P0EvaluationSchema.innerType().shape.claims,claimsRaw);
    return { metadata: (rawDefinition,scope) => {
      const definition = this.parse(ToolDefinitionSchema,rawDefinition);
      return this.read((r,tx) => {
        if (canonical(definition.context) !== canonical(this.context)) throw new StorageError("CONTEXT_MISMATCH");
        const binding = r.binding(target,definition.name), selected = binding ? r.latest(String(binding.id)) : null;
        if (!selected || selected.action === "deactivate") return null;
        const release = r.get(selected.releaseId);
        if (release.lifecycle !== "published") return null;
        const proof = this.proof(r,tx,target,definition.name,release.definition,release.scope,release.toolAnchor);
        if (canonical(toolAnchor(definition)) !== canonical(proof.anchor) || toolJson(scope) !== canonical(proof.upstream)) return null;
        return ToolPolicyMetadataSchema.parse({ context:this.context,anchor:proof.anchor,scope,complete:true,
          policyRevision:policyHash({ fence:r.pin(),selection:selected }),
          evaluationJson:canonical({ profile:"canonical_resource_rules@1",path_semantics:"posix_case_sensitive",
            upstream_scope:proof.upstream,approval_required:proof.approvalRequired,policies:proof.policies,claims }) });
      });
    } };
  }
  simulate(raw: unknown) { return this.preview(raw); }
}

/** Trusted host construction only. Preflight is captured before any P1 write or
 * read transaction; every P1 proof rechecks its exact live Source inside that
 * transaction. No IPC, renderer payload, Tool adapter or Registry mutation. */
export function publishedSourcePolicyService(store:SqliteFoundation,context:LocalContext,
  source:LocalSourcePublicationService,registry:ToolRegistry,sourceId:string,key:string,
  clock=()=>new Date()) {
  if (canonical(store.workspace)!==canonical(context) || canonical(source.context)!==canonical(context))
    throw new StorageError("CONTEXT_MISMATCH");
  const toolName=publishedSourcePolicyName(sourceId,key);
  let preflight:PublishedSourcePolicyPreflight|null=null;
  const binding:PublishedSourcePolicyHostBinding={ toolName,
    prepare:()=>{ preflight=null; preflight=source.preparePolicyContract(sourceId,key); },
    clear:()=>{ preflight=null; },
    revalidate:(tx) => {
      if (!preflight) throw new StorageError("SOURCE_DISCOVERY_NOT_READY");
      return source.revalidatePolicyContract(tx,preflight);
    } };
  return { toolName,policy:new LocalPolicyService(store,context,()=>null,registry,clock,binding) };
}
