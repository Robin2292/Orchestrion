import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentRepository, AGENT_FENCE, AGENT_INITIAL_HASH } from "../agents/repository";
import { agentCommandBytes } from "../agents/service";
import { type LocalBudgetCeilings } from "../budgets/repository";
import { LocalDirectGrantCeilingRepository } from "../direct-grant-ceilings/repository";
import { grantSetDigest } from "../grants/repository";
import { JobEventBus } from "../jobs/event-bus";
import { AgentCreateSchema, AgentDefinitionSchema, LocalAgentSchema, LocalAgentVersionSchema } from "../shared/agent-contracts";
import { AGENT_SESSION_CONTRACT_VERSION, ProjectAgentAssignmentVersionSchema,
  compileAssignmentVersionHashes } from "../shared/agent-session-contracts";
import { LocalCommandHeaderSchema, LocalContextSchema, LocalIdSchema,
  type LocalCommandHeader, type LocalContext } from "../shared/local-contracts";
import { ToolGrantSetSchema, grantCanonicalJson } from "../shared/tool-grant-contracts";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { LocalAssignmentRepository } from "./repository";
import { LocalDirectGrantReadinessService, type DirectGrantReadyProof } from "./direct-grant-readiness";
import { DEFAULT_AGENT_SOUL } from "../shared/agent-soul-contracts";
import { normalizeAgentSoul } from "../agents/soul-document";

const CreateSchema = AgentCreateSchema.extend({
  visibility: z.enum(["organization","project"]),
  sourceVersionId: LocalIdSchema.nullable(),
}).strict();
const EMPTY_GRANTS = ToolGrantSetSchema.parse({ schema_version:"tool_grants@1", grants:[] });
export type AssignmentBudgetBounds = { modelTokens:number; toolCalls:number; costUsd:number };
export type AssignmentBudgetAuthority = (tx:SqliteUnit, context:LocalContext, assignmentId:string) =>
  LocalBudgetCeilings | null;

/** Host-owned D2 Assignment service. No Session admission is registered here. */
export class LocalProjectAssignmentService {
  readonly context: LocalContext;
  constructor(private readonly store: SqliteFoundation, context: LocalContext,
              private readonly clock: () => Date = () => new Date(),
              private readonly events: JobEventBus = new JobEventBus(),
              private readonly budgetAuthority: AssignmentBudgetAuthority | null = null,
              private readonly grantReadiness: LocalDirectGrantReadinessService | null = null) {
    this.context = LocalContextSchema.parse(context);
    if (grantReadiness && agentCommandBytes(grantReadiness.context)!==agentCommandBytes(this.context))
      throw new StorageError("CONTEXT_MISMATCH");
    this.store.transaction(tx => {
      const r = new LocalAssignmentRepository(tx,this.context); r.authorize();
      if (!tx.get("SELECT 1 FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",
        this.context.org_id,this.context.project_id,AGENT_FENCE))
        SqliteFoundation.createFence(tx,this.context,AGENT_FENCE,AGENT_INITIAL_HASH);
    });
  }
  private now(): string { return this.clock().toISOString().slice(0,19)+"Z"; }
  private boundedBudget(tx:SqliteUnit, assignmentId:string, requested:unknown):LocalBudgetCeilings {
    if (!this.budgetAuthority) throw new StorageError("ASSIGNMENT_BUDGET_AUTHORITY_REQUIRED");
    const valid=(value:unknown):value is AssignmentBudgetBounds => {
      if (!value || typeof value!=="object") return false;
      const budget=value as Record<string,unknown>;
      return typeof budget.modelTokens==="number" && Number.isSafeInteger(budget.modelTokens) && budget.modelTokens>0
        && typeof budget.toolCalls==="number" && Number.isSafeInteger(budget.toolCalls) && budget.toolCalls>0
        && typeof budget.costUsd==="number" && Number.isFinite(budget.costUsd) && budget.costUsd>=0;
    };
    if (!valid(requested)) throw new StorageError("ASSIGNMENT_BUDGET_CEILING_INVALID");
    let bounds:LocalBudgetCeilings | null;
    try { bounds=this.budgetAuthority(tx,this.context,assignmentId); }
    catch (error) {
      if (error instanceof StorageError && ["BUDGET_CEILING_REQUIRED","BUDGET_AGENT_PRINCIPAL_UNAVAILABLE"].includes(error.code))
        throw new StorageError("ASSIGNMENT_BUDGET_AUTHORITY_REQUIRED");
      throw error;
    }
    if (!bounds) throw new StorageError("ASSIGNMENT_BUDGET_AUTHORITY_REQUIRED");
    if (!Number.isSafeInteger(bounds.organizationRevision) || !Number.isSafeInteger(bounds.principalRevision))
      throw new StorageError("ASSIGNMENT_BUDGET_AUTHORITY_REQUIRED");
    for (const ceiling of [bounds.organization,bounds.principal]) {
      if (!valid(ceiling) || requested.modelTokens>ceiling.modelTokens
          || requested.toolCalls>ceiling.toolCalls || requested.costUsd>ceiling.costUsd)
        throw new StorageError("ASSIGNMENT_BUDGET_CEILING_EXCEEDED");
    }
    return bounds;
  }
  /** Empty selection still records each live source independently. Missing
   * ceilings are explicit deny, while a stale Principal ancestor is Not Ready. */
  private emptySelectionCeilings(tx:SqliteUnit, agentPrincipalId:string) {
    const r=new LocalDirectGrantCeilingRepository(tx,this.context);
    const organization=r.active("organization",this.context.org_id);
    const principal=r.active("agent",agentPrincipalId);
    const organizationIds=new Set(organization.map(item=>item.versionId));
    if (principal.some(item=>!item.parentOrganizationVersionId
        || !organizationIds.has(item.parentOrganizationVersionId)))
      throw new StorageError("ASSIGNMENT_NOT_READY");
    return {organizationRevision:r.latest("organization",this.context.org_id)?.revision??0,
      principalRevision:r.latest("agent",agentPrincipalId)?.revision??0,
      organizationVersionIds:organization.map(item=>item.versionId),
      principalVersionIds:principal.map(item=>item.versionId),
      organizationCeilingHash:grantSetDigest(ToolGrantSetSchema.parse({
        schema_version:"tool_grants@1",grants:organization.map(item=>item.grant)})),
      principalGrantHash:grantSetDigest(ToolGrantSetSchema.parse({
        schema_version:"tool_grants@1",grants:principal.map(item=>item.grant)}))};
  }
  private read<T>(work: (r: LocalAssignmentRepository,tx: SqliteUnit) => T): T {
    return this.store.transaction(tx => {
      const r = new LocalAssignmentRepository(tx,this.context); r.authorize();
      return work(r,tx);
    });
  }
  authority() {
    return { context:structuredClone(this.context),runtime_owner:this.store.owner,
      expected:this.read((_r,tx) => {
        const row = tx.get("SELECT revision,hash FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",
          this.context.org_id,this.context.project_id,AGENT_FENCE)!;
        return { revision:Number(row.revision),hash:String(row.hash) };
      }),run:null };
  }
  /** Read-only choices for one scoped Assignment. These are live candidate IDs,
   * not authority: a release rechecks the exact set inside its fenced commit. */
  async grantPreview(assignmentId:string,agentVersionId:string,principalVersionIds:string[]) {
    assignmentId=LocalIdSchema.parse(assignmentId);agentVersionId=LocalIdSchema.parse(agentVersionId);
    const requested=principalVersionIds.map(id=>LocalIdSchema.parse(id));
    if (requested.length>32 || new Set(requested).size!==requested.length)
      throw new StorageError("INVALID_PAYLOAD");
    const selection=this.read((r,tx)=>{
      const assignment=r.assignment(assignmentId);
      if (!assignment || assignment.status!=="active" || assignment.migration_state!=="governed")
        return {reason:"ASSIGNMENT_NOT_READY" as const,options:[]};
      const agent=r.identity(assignment.agent_id);
      if (!agent || agent.identity_state!=="governed" || agent.removed_at!==null)
        return {reason:"AGENT_VERSION_NOT_READY" as const,options:[]};
      const version=r.sourceVersion(agent,agentVersionId);
      if (!version) return {reason:"AGENT_VERSION_NOT_READY" as const,options:[]};
      const definition=AgentDefinitionSchema.parse(JSON.parse(version.definition_json));
      if (definition.nodeType!=="agent" || !definition.toolGrants)
        return {reason:"AGENT_VERSION_NOT_READY" as const,options:[]};
      let ceiling;
      try { ceiling=new LocalDirectGrantCeilingRepository(tx,this.context)
        .resolveForAssignment(assignmentId,this.context.project_id); }
      catch (error) {
        if (error instanceof StorageError && error.code.startsWith("DIRECT_GRANT_"))
          return {reason:null,options:[]};
        throw error;
      }
      const exact=new Set(definition.toolGrants.grants.map(grantCanonicalJson));
      const parents=new Set(ceiling.organization.map(item=>item.versionId));
      const options=ceiling.principal.filter(item=>item.parentOrganizationVersionId &&
        parents.has(item.parentOrganizationVersionId) && exact.has(grantCanonicalJson(item.grant)))
        .map(item=>({principalVersionId:item.versionId,grant:item.grant}));
      return {reason:null,options};
    });
    const {options}=selection;
    if (selection.reason) return {options,readiness:{state:"not_ready" as const,
      reason:selection.reason,executionReady:false as const}};
    if (!requested.length) return {options,readiness:{state:"empty" as const,executionReady:false as const}};
    if (!this.grantReadiness) return {options,readiness:{state:"not_ready" as const,
      reason:"ASSIGNMENT_NOT_READY" as const,executionReady:false as const}};
    const proof=await this.grantReadiness.readiness({assignmentId,agentVersionId,principalVersionIds:requested});
    return {options,readiness:proof.state==="ready"
      ? {state:"ready" as const,executionReady:false as const}
      : {state:"not_ready" as const,reason:proof.reason,executionReady:false as const}};
  }
  private mutate(header: LocalCommandHeader, command: string, payload: unknown,
                 work: (r: LocalAssignmentRepository,tx: SqliteUnit) => string) {
    header = LocalCommandHeaderSchema.parse(header);
    if (header.run !== null) throw new StorageError("INVALID_PAYLOAD");
    const bytes = agentCommandBytes(payload);
    this.read(r => r.authorize(true));
    const result=this.store.commit({ trustedContext:this.context,header,command,resourceKey:AGENT_FENCE,
      canonicalContent:bytes,nextHash:`sha256:${createHash("sha256").update(bytes).digest("hex")}` },tx => {
      const r = new LocalAssignmentRepository(tx,this.context); r.authorize(true);
      return work(r,tx);
    });
    this.events.publish(); // advisory wakeup only, after the durable fact commits
    return result;
  }
  createAgent(header: LocalCommandHeader, raw: unknown) {
    const p = CreateSchema.parse(raw);
    if (p.definition.nodeType !== "agent" || p.definition.toolGrants === null
        || p.definition.toolGrants?.grants.length) throw new StorageError("INVALID_PAYLOAD");
    return this.mutate(header,"assignment.agent.create",p,(r,tx) => {
      r.authorize(true,p.visibility === "organization");
      if (p.sourceVersionId !== null) {
        const source = tx.get(`SELECT a.* FROM agent_identities a
          JOIN local_agent_versions v ON v.org_id=a.org_id AND v.project_id=a.home_project_id
            AND v.principal_type=a.owner_principal_type AND v.principal_id=a.owner_principal_id
            AND v.agent_id=a.id WHERE a.org_id=? AND v.id=?`,this.context.org_id,p.sourceVersionId);
        if (!source || source.identity_state !== "governed") throw new StorageError("AGENT_VERSION_NOT_FOUND");
        if (source.visibility!=="organization" && source.home_project_id!==this.context.project_id)
          throw new StorageError("AGENT_VARIANT_SOURCE_SCOPE_DENIED");
        const identity = r.identity(String(source.id));
        if (!identity) throw new StorageError("AGENT_VERSION_NOT_FOUND");
        const sourceVersion = r.sourceVersion(identity,p.sourceVersionId);
        if (!sourceVersion || agentCommandBytes(JSON.parse(sourceVersion.definition_json)) !== agentCommandBytes(p.definition))
          throw new StorageError("INVALID_PAYLOAD");
      }
      const now=this.now(), id=randomUUID(),versionId=randomUUID();
      const a = new AgentRepository(tx,this.context); a.authorize(true);
      a.insert(LocalAgentSchema.parse({ schemaVersion:"orchestrion.local.agent.v1",context:this.context,
        id,nodeType:"agent",name:p.name,description:p.description,userGuide:p.userGuide,
        latestVersionId:null,legacyDraft:null,createdAt:now,updatedAt:now,deletedAt:null }));
      const soul=normalizeAgentSoul(p.definition.systemPrompt ?? (p.sourceVersionId === null ? DEFAULT_AGENT_SOUL : ""));
      a.insertVersion(LocalAgentVersionSchema.parse({ schemaVersion:"orchestrion.local.agent.v1",context:this.context,
        id:versionId,agentId:id,versionNumber:1,
        definition:{...p.definition,systemPrompt:soul.content,toolGrants:EMPTY_GRANTS},soul,createdAt:now }));
      r.insertIdentity(id,p.name,p.visibility,p.sourceVersionId,now);
      const assignmentId=randomUUID();r.add(assignmentId,id,now);
      r.event("created",id,assignmentId,now);
      return id;
    });
  }
  adoptExisting(header: LocalCommandHeader, agentId: string) {
    agentId=LocalIdSchema.parse(agentId);
    return this.mutate(header,"assignment.agent.adopt",{agentId},r => {
      r.authorize(true,true);
      const identity=r.identity(agentId);
      if (!identity || identity.identity_state!=="legacy_unresolved") throw new StorageError("AGENT_NOT_FOUND");
      // Legacy import may have only a prompt draft. An explicit adoption needs
      // a real immutable first-class version; it still releases no authority.
      const version=r.latestSourceVersion(identity);
      if (!version) throw new StorageError("AGENT_VERSION_NOT_FOUND");
      const definition=JSON.parse(version.definition_json);
      if (definition.nodeType!=="agent") throw new StorageError("AGENT_VERSION_NOT_FOUND");
      r.adopt(agentId); r.event("adopted",agentId,null,this.now()); return agentId;
    });
  }
  add(header: LocalCommandHeader, agentId: string) {
    agentId=LocalIdSchema.parse(agentId);
    return this.mutate(header,"assignment.add",{agentId},r => {
      // Admission must use the same live, scoped identity and backing Agent
      // contract as the catalog, inside the fenced write transaction.
      if (!r.catalogIdentity(agentId))
        throw new StorageError("ASSIGNMENT_PLACEMENT_DENIED");
      if (r.assignmentForAgent(agentId)) throw new StorageError("ASSIGNMENT_ALREADY_EXISTS");
      const id=randomUUID(),now=this.now(); r.add(id,agentId,now);r.event("added",agentId,id,now);return id;
    });
  }
  private transition(header: LocalCommandHeader, id: string, from: string, to: string) {
    id=LocalIdSchema.parse(id);
    return this.mutate(header,`assignment.${to}`,{id},r => {
      if (!r.assignment(id)) throw new StorageError("ASSIGNMENT_NOT_FOUND");
      const now=this.now();r.status(id,from,to,now);
      r.event(to as "disabled"|"enabled"|"removed",r.assignment(id)!.agent_id,id,now);
      return id;
    });
  }
  disable(header: LocalCommandHeader,id: string) { return this.transition(header,id,"active","disabled"); }
  enable(header: LocalCommandHeader,id: string) { return this.transition(header,id,"disabled","active"); }
  remove(header: LocalCommandHeader,id: string) {
    const row=this.read(r => r.assignment(LocalIdSchema.parse(id)));
    if (!row || row.status==="removed") throw new StorageError("ASSIGNMENT_NOT_FOUND");
    return this.transition(header,id,row.status,"removed");
  }
  promote(header: LocalCommandHeader,agentId: string) {
    agentId=LocalIdSchema.parse(agentId);
    return this.mutate(header,"assignment.agent.promote",{agentId},r => {
      r.authorize(true,true); r.promote(agentId);r.event("promoted",agentId,null,this.now());return agentId;
    });
  }
  async configure(header: LocalCommandHeader, assignmentId: string, agentVersionId: string,
                  config: Record<string,unknown>, assertActive: () => void = () => {}) {
    if (this.context.principal.type!=="user") throw new StorageError("NOT_AUTHENTICATED");
    header=LocalCommandHeaderSchema.parse(header);
    assignmentId=LocalIdSchema.parse(assignmentId); agentVersionId=LocalIdSchema.parse(agentVersionId);
    config=structuredClone(config);
    // F4 replay returns only the old durable result. It must not re-authorize a
    // release against facts that may have since been revoked.
    if (this.read(r=>r.hasConfigureReplay(header.idempotency_key)))
      return this.mutate(header,"assignment.configure",{assignmentId,agentVersionId,config},()=>{
        throw new StorageError("REVISION_CONFLICT");
      });
    const snapshot=this.read((r,tx) => {
      const assignment=r.assignment(assignmentId);
      if (!assignment || assignment.status!=="active" || assignment.migration_state!=="governed")
        throw new StorageError("ASSIGNMENT_NOT_ACTIVE");
      const agent=r.identity(assignment.agent_id);
      if (!agent || agent.identity_state!=="governed") throw new StorageError("AGENT_NOT_FOUND");
      const version=r.sourceVersion(agent,agentVersionId);
      if (!version) throw new StorageError("AGENT_VERSION_NOT_FOUND");
      const definition=JSON.parse(version.definition_json);
      if (!definition.toolGrants) throw new StorageError("ASSIGNMENT_AUTHORITY_UNRESOLVED");
      return {assignment,agent,definitionHash:agentCommandBytes(definition),revision:r.latestRevision(assignmentId)+1,
        grantHash:grantSetDigest(ToolGrantSetSchema.parse(definition.toolGrants)),
        emptyCeilings:this.emptySelectionCeilings(tx,agent.id)};
    });
    const ceiling=config.authorityCeiling as Record<string,unknown> | undefined;
    const requestedIds=ceiling?.directGrantVersionIds;
    if (!Array.isArray(requestedIds) || requestedIds.length>32
        || requestedIds.some(id=>!LocalIdSchema.safeParse(id).success))
      throw new StorageError("ASSIGNMENT_AUTHORITY_UNRESOLVED");
    const nonempty=requestedIds.length>0;
    if (config.parameterValues===undefined || agentCommandBytes(config.parameterValues)!=="{}"
        || agentCommandBytes(config.connectionBindings)!=="[]"
        || agentCommandBytes(config.credentialReferences)!=="[]"
        || agentCommandBytes(config.policyReferences)!=="[]"
        || agentCommandBytes(config.dataScope)!=='{"domains":[],"resourceReferences":[]}'
        || agentCommandBytes(config.workspaceScope)!=='{"mode":"none","pathPrefixes":[]}'
        || agentCommandBytes(config.placementConstraints)!=='{"allowed":["local_trusted"],"fallback":"forbidden"}')
      throw new StorageError("ASSIGNMENT_AUTHORITY_UNRESOLVED");
    const memory=config.memoryScopeCeiling as Record<string,unknown> | undefined;
    if (memory?.projectId!==this.context.project_id || memory.organizationPromotionAllowed!==false
        || memory.projectPromotionAllowed!==false || agentCommandBytes(memory.allowedWorkflowIds)!=="[]"
        || agentCommandBytes(memory.allowedDataDomains)!=="[]") throw new StorageError("ASSIGNMENT_MEMORY_SCOPE_DENIED");
    // A replay must still be able to return its durable prior result after a
    // ceiling is revoked. Record the pre-hash revision when available; the
    // fenced commit performs the mandatory live check for new releases.
    let initialBudget:LocalBudgetCeilings | null = null;
    try { initialBudget=this.read((_r,tx) => this.boundedBudget(tx,assignmentId,config.budgetCeilings)); }
    catch (error) {
      if (!(error instanceof StorageError) || !["ASSIGNMENT_BUDGET_AUTHORITY_REQUIRED",
        "ASSIGNMENT_BUDGET_CEILING_EXCEEDED"].includes(error.code)) throw error;
    }
    if (initialBudget && initialBudget.agentPrincipalId!==snapshot.agent.id)
      throw new StorageError("ASSIGNMENT_BUDGET_AUTHORITY_REQUIRED");
    if (nonempty && !this.grantReadiness) throw new StorageError("ASSIGNMENT_NOT_READY");
    const proofInput={assignmentId,agentVersionId,principalVersionIds:requestedIds};
    const preflight=nonempty ? await this.grantReadiness!.readiness(proofInput) : null;
    if (preflight?.state==="not_ready") throw new StorageError("ASSIGNMENT_NOT_READY");
    if (preflight && (preflight.agentPrincipalId!==snapshot.agent.id
        || preflight.agentVersionGrantHash!==snapshot.grantHash))
      throw new StorageError("ASSIGNMENT_NOT_READY");
    // Caller hashes are not authority. The complete live sets and canonical
    // selected IDs come from the host's read-only proof.
    const draftCeiling=preflight ? {organizationCeilingHash:preflight.organizationCeilingHash,
      principalGrantHash:preflight.principalGrantHash,agentVersionGrantHash:preflight.agentVersionGrantHash,
      directGrantVersionIds:preflight.selected.map(item=>item.principalVersionId)}
      : {organizationCeilingHash:snapshot.emptyCeilings.organizationCeilingHash,
        principalGrantHash:snapshot.emptyCeilings.principalGrantHash,
        agentVersionGrantHash:snapshot.grantHash,directGrantVersionIds:[]};
    const now=this.now(), id=randomUUID();
    const draft=ProjectAgentAssignmentVersionSchema.parse({ ...config,authorityCeiling:draftCeiling,
      schemaVersion:AGENT_SESSION_CONTRACT_VERSION,
      id,orgId:this.context.org_id,assignmentId,revision:snapshot.revision,agentVersionId,
      resolvedConfigHash:`sha256:${"0".repeat(64)}`,authorityCeilingHash:`sha256:${"0".repeat(64)}`,
      memoryScopeHash:`sha256:${"0".repeat(64)}`,createdAt:now,createdByPrincipalId:this.context.principal.id });
    const contract=ProjectAgentAssignmentVersionSchema.parse({...draft,
      ...await compileAssignmentVersionHashes(draft)});
    let prepared:Awaited<ReturnType<LocalDirectGrantReadinessService["prepare"]>>|null=null;
    if (nonempty) {
      try { prepared=await this.grantReadiness!.prepare(proofInput); }
      catch { throw new StorageError("ASSIGNMENT_NOT_READY"); }
    }
    assertActive();
    return this.mutate(header,"assignment.configure",{assignmentId,agentVersionId,config},(r,tx) => {
      const row=r.assignment(assignmentId);
      if (!row || row.status!=="active" || row.agent_id!==snapshot.agent.id
          || r.latestRevision(assignmentId)+1!==snapshot.revision)
        throw new StorageError("REVISION_CONFLICT");
      const liveAgent=r.identity(row.agent_id);
      if (!liveAgent || liveAgent.identity_state!=="governed" || liveAgent.removed_at!==null
          || liveAgent.agent_principal_id!==snapshot.agent.id
          || (liveAgent.visibility!=="organization" && liveAgent.home_project_id!==this.context.project_id))
        throw new StorageError("ASSIGNMENT_PLACEMENT_DENIED");
      const liveVersion=r.sourceVersion(liveAgent,agentVersionId);
      if (!liveVersion || agentCommandBytes(JSON.parse(liveVersion.definition_json))!==snapshot.definitionHash)
        throw new StorageError("AGENT_VERSION_NOT_FOUND");
      if (!nonempty && agentCommandBytes(this.emptySelectionCeilings(tx,liveAgent.id))
          !==agentCommandBytes(snapshot.emptyCeilings))
        throw new StorageError("ASSIGNMENT_NOT_READY");
      const liveBudget=this.boundedBudget(tx,assignmentId,contract.budgetCeilings);
      if (!initialBudget || liveBudget.agentPrincipalId!==snapshot.agent.id
          || liveBudget.organizationRevision!==initialBudget.organizationRevision
          || liveBudget.principalRevision!==initialBudget.principalRevision)
        throw new StorageError("ASSIGNMENT_BUDGET_AUTHORITY_REQUIRED");
      if (prepared) {
        let proof:DirectGrantReadyProof;
        try { proof=prepared.check(tx); }
        catch { throw new StorageError("ASSIGNMENT_NOT_READY"); }
        if (agentCommandBytes(proof)!==agentCommandBytes(preflight))
          throw new StorageError("ASSIGNMENT_NOT_READY");
      }
      r.appendVersion(id,row,snapshot.agent,agentVersionId,snapshot.revision,contract,now);
      r.event("version_released",row.agent_id,row.id,now);
      return id;
    });
  }
  get(assignmentId: string) {
    return this.read(r => r.assignment(LocalIdSchema.parse(assignmentId)));
  }
  detail(assignmentId: string) {
    return this.read(r => {
      const assignment=r.assignment(LocalIdSchema.parse(assignmentId));
      if (!assignment) return null;
      const agent=r.identity(assignment.agent_id);
      if (!agent) throw new StorageError("AGENT_IDENTITY_UNAVAILABLE");
      const currentVersion=assignment.current_assignment_version_id
        ? r.version(assignment.id,assignment.current_assignment_version_id) : null;
      if (assignment.current_assignment_version_id && !currentVersion)
        throw new StorageError("ASSIGNMENT_VERSION_NOT_FOUND");
      return {assignment,agent,currentVersion};
    });
  }
  list(limit: number, offset: number) {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100 || !Number.isSafeInteger(offset) || offset<0)
      throw new StorageError("INVALID_PAYLOAD");
    return this.read(r => r.list(limit,offset).map(assignment => {
      const agent=r.identity(assignment.agent_id);
      if (!agent) throw new StorageError("AGENT_IDENTITY_UNAVAILABLE");
      const currentVersion=assignment.current_assignment_version_id
        ? r.version(assignment.id,assignment.current_assignment_version_id) : null;
      if (assignment.current_assignment_version_id && !currentVersion)
        throw new StorageError("ASSIGNMENT_VERSION_NOT_FOUND");
      return {assignment,agent,currentVersion};
    }));
  }
}
