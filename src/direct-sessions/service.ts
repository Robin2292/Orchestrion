import { createHash, randomUUID } from "node:crypto";
import { agentCommandBytes } from "../agents/service";
import { verifyAgentSoul } from "../agents/soul-document";
import { grantSetDigest } from "../grants/repository";
import { JobEventBus } from "../jobs/event-bus";
import { LocalCommandHeaderSchema, LocalContextSchema, LocalIdSchema, RuntimeOwnerSchema,
  type LocalCommandHeader, type LocalContext, type RuntimeOwner } from "../shared/local-contracts";
import { ToolGrantSetSchema } from "../shared/tool-grant-contracts";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { DirectSessionRepository, type DirectSessionRow } from "./repository";
import { composeDirectStaticPrefix, DirectRepositoryInstructions,
  type RepositoryInstructionSource } from "./repository-instructions";

const FENCE="direct_sessions";
const INITIAL_HASH=`sha256:${"0".repeat(64)}`;
const EMPTY_GRANTS=grantSetDigest(ToolGrantSetSchema.parse({schema_version:"tool_grants@1",grants:[]}));
const hash=(value:unknown)=>`sha256:${createHash("sha256").update(agentCommandBytes(value)).digest("hex")}`;
const title=(value:string)=>{
  if (typeof value!=="string" || !value.trim() || value.trim().length>255) throw new StorageError("INVALID_PAYLOAD");
  return value.trim();
};

/** Trusted host proof. No renderer/model value may substitute for a live binding. */
export interface DirectExecutionBinding {
  placementBindingId:string;
  workspaceBindingId:string;
  sourceRevision:string;
  fencingToken:string;
  providerExecutionRef:string|null;
}
export type VerifyDirectBinding = (context:LocalContext, session:DirectSessionRow,
  binding:DirectExecutionBinding)=>boolean;
/** Trusted provider evidence that the prior execution can no longer produce effects. */
export interface DirectStopProof {
  workspaceBindingId:string;
  providerExecutionRef:string|null;
  stopToken:string;
}
export type VerifyDirectStop = (context:LocalContext, session:DirectSessionRow,
  attempt:NonNullable<ReturnType<DirectSessionRepository["attempt"]>>,proof:DirectStopProof)=>boolean;
/** Host-only cleanup pin. Every identity and binding field comes from SQLite, not IPC.
 * A provider adapter must authenticate this exact reference and dedupe by the key. */
export interface DirectProviderCleanup {
  orgId:string; projectId:string; sessionId:string; attemptId:string; attemptNumber:number;
  providerExecutionRef:string; runtimeOwner:RuntimeOwner; placementBindingId:string;
  workspaceBindingId:string; fencingToken:string; idempotencyKey:string;
}
export type DirectProviderCleanupResult="deleted"|"already_absent";
export type DeleteDirectProvider=(pin:Readonly<DirectProviderCleanup>)=>Promise<DirectProviderCleanupResult>;
const deleteInFlight=new WeakMap<SqliteFoundation,Set<string>>();

/** The service is the sole writer of released Direct Session and attempt facts.
 * It does not route a provider, grant tools or create a writable workspace. A
 * dispatch caller must pass assertDispatch immediately before any model call. */
export class DirectSessionService {
  readonly context:LocalContext;
  constructor(private readonly store:SqliteFoundation,context:LocalContext,
    private readonly verifyBinding:VerifyDirectBinding,
    private readonly verifyStopped:VerifyDirectStop=()=>false,
    private readonly clock:()=>Date=()=>new Date(),private readonly events:JobEventBus=new JobEventBus(),
    private readonly repositoryInstructions?:DirectRepositoryInstructions) {
    this.context=LocalContextSchema.parse(context);
    if (!deleteInFlight.has(store)) deleteInFlight.set(store,new Set());
    this.store.transaction(tx=>{
      const r=new DirectSessionRepository(tx,this.context);r.authorizeWrite();
      if (!tx.get(`SELECT 1 FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?`,
        this.context.org_id,this.context.project_id,FENCE))
        SqliteFoundation.createFence(tx,this.context,FENCE,INITIAL_HASH);
    });
  }
  private now():string { return this.clock().toISOString().slice(0,19)+"Z"; }
  private read<T>(work:(r:DirectSessionRepository,tx:SqliteUnit)=>T):T {
    return this.store.transaction(tx=>work(new DirectSessionRepository(tx,this.context),tx));
  }
  list(limit:number,offset:number) {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100 || !Number.isSafeInteger(offset) || offset<0)
      throw new StorageError("INVALID_PAYLOAD");
    return this.read(r=>r.list(limit,offset));
  }
  latestAttempt(sessionId:string) { return this.read(r=>r.latestAttempt(sessionId)); }
  authority() {
    return {context:structuredClone(this.context),runtime_owner:this.store.owner,
      expected:this.read((_r,tx)=>{
        const row=tx.get(`SELECT revision,hash FROM resource_fences
          WHERE org_id=? AND project_id=? AND resource_key=?`,
          this.context.org_id,this.context.project_id,FENCE)!;
        return {revision:Number(row.revision),hash:String(row.hash)};
      }),run:null};
  }
  private mutate(header:LocalCommandHeader,command:string,payload:unknown,
    work:(r:DirectSessionRepository,tx:SqliteUnit)=>string) {
    header=LocalCommandHeaderSchema.parse(header);
    if (header.run!==null || this.context.principal.type!=="user") throw new StorageError("NOT_AUTHENTICATED");
    const bytes=agentCommandBytes(payload);
    const result=this.store.commit({trustedContext:this.context,header,command,resourceKey:FENCE,
      canonicalContent:bytes,nextHash:hash([command,bytes])},tx=>{
      const r=new DirectSessionRepository(tx,this.context);r.authorizeWrite();
      return work(r,tx);
    });
    this.events.publish();
    return result;
  }
  private live(r:DirectSessionRepository,id:string,allowDeleting=false):DirectSessionRow {
    const s=r.session(id);
    if (!s || s.provenance!=="released" || s.deleted_at!==null)
      throw new StorageError("DIRECT_SESSION_UNAVAILABLE");
    if (!allowDeleting && s.deletion_state!=="ready") throw new StorageError("DIRECT_SESSION_STATE_CONFLICT");
    return s;
  }
  private admitted(r:DirectSessionRepository,s:DirectSessionRow,allowArchived=false) {
    if ((!allowArchived && s.lifecycle!=="active") || !s.assignment_id || !s.assignment_version_id || !s.agent_version_id)
      throw new StorageError("DIRECT_SESSION_INACTIVE");
    const facts=r.released(s.assignment_id,s.assignment_version_id), v=facts.contract;
    if (v.id!==s.assignment_version_id || v.agentVersionId!==s.agent_version_id
      || v.resolvedConfigHash!==s.resolved_config_hash || facts.identity.id!==s.agent_id)
      throw new StorageError("DIRECT_PIN_REVOKED");
    const c=this.context;
    if (v.authorityCeiling.organizationCeilingHash!==EMPTY_GRANTS
      || v.authorityCeiling.principalGrantHash!==EMPTY_GRANTS
      || v.authorityCeiling.agentVersionGrantHash!==EMPTY_GRANTS
      || v.authorityCeiling.directGrantVersionIds.length!==0
      || v.connectionBindings.length!==0 || v.credentialReferences.length!==0
      || v.policyReferences.length!==0 || v.dataScope.domains.length!==0
      || v.dataScope.resourceReferences.length!==0 || Object.keys(v.parameterValues).length!==0
      || v.workspaceScope.mode!=="none" || v.workspaceScope.pathPrefixes.length!==0
      || agentCommandBytes(v.placementConstraints)!=='{"allowed":["local_trusted"],"fallback":"forbidden"}'
      || v.memoryScopeCeiling.projectId!==c.project_id
      || v.memoryScopeCeiling.allowedWorkflowIds.length!==0
      || v.memoryScopeCeiling.allowedDataDomains.length!==0
      || v.memoryScopeCeiling.projectPromotionAllowed
      || v.memoryScopeCeiling.organizationPromotionAllowed)
      throw new StorageError("DIRECT_AUTHORITY_UNAVAILABLE");
    const b=v.budgetCeilings,ceilings=facts.budget;
    if (b.modelTokens===null || b.toolCalls===null || b.costUsd===null
      || b.modelTokens>ceilings.organization.modelTokens || b.modelTokens>ceilings.principal.modelTokens
      || b.toolCalls>ceilings.organization.toolCalls || b.toolCalls>ceilings.principal.toolCalls
      || b.costUsd>ceilings.organization.costUsd || b.costUsd>ceilings.principal.costUsd)
      throw new StorageError("DIRECT_BUDGET_REVOKED");
    return {facts,authorityHash:hash({assignment:v.authorityCeilingHash,
      organizationBudgetRevision:ceilings.organizationRevision,
      principalBudgetRevision:ceilings.principalRevision,
      agentPrincipalId:ceilings.agentPrincipalId})};
  }
  create(header:LocalCommandHeader,assignmentId:string,assignmentVersionId:string,rawTitle:string) {
    assignmentId=LocalIdSchema.parse(assignmentId);
    assignmentVersionId=LocalIdSchema.parse(assignmentVersionId);
    const name=title(rawTitle);
    return this.mutate(header,"direct.create",{assignmentId,assignmentVersionId,title:name},r=>{
      const facts=r.released(assignmentId);
      if (facts.contract.id!==assignmentVersionId) throw new StorageError("DIRECT_VERSION_CHANGED");
      // Evaluate every live ceiling before freezing the exact current release.
      const id=randomUUID();
      const temporary={id,agent_id:facts.identity.id,assignment_id:assignmentId,
        assignment_version_id:facts.contract.id,agent_version_id:facts.contract.agentVersionId,
        resolved_config_hash:facts.contract.resolvedConfigHash,lifecycle:"active",deleted_at:null} as DirectSessionRow;
      this.admitted(r,temporary);
      r.insert(id,facts,name,this.now());return id;
    });
  }
  get(id:string) { return this.read(r=>r.session(LocalIdSchema.parse(id))); }
  /** Host-only read path for A4C. Revalidate the live assignment on every build,
   * including after restart; an old attempt owner is not needed for read-only rehydration. */
  contextAdmission(id:string,attemptId?:string) {
    id=LocalIdSchema.parse(id);
    if(attemptId!==undefined)attemptId=LocalIdSchema.parse(attemptId);
    const pin=this.read(r=>{
      const s=this.live(r,id),{facts}=this.admitted(r,s);
      if(facts.assignment.current_assignment_version_id!==s.assignment_version_id)
        throw new StorageError("DIRECT_PIN_REVOKED");
      const scope={type:"direct",projectId:this.context.project_id,sessionId:id,sharing:"session_only"};
      if (JSON.stringify(JSON.parse(String((s as DirectSessionRow & {memory_scope_json:string}).memory_scope_json)))
        !==JSON.stringify(scope)) throw new StorageError("DIRECT_MEMORY_SCOPE_CHANGED");
      const definition=JSON.parse(facts.source.definition_json) as {systemPrompt?:unknown;modelId?:unknown};
      if (typeof definition.modelId!=="string" || definition.systemPrompt!==null
        && definition.systemPrompt!==undefined && typeof definition.systemPrompt!=="string")
        throw new StorageError("DIRECT_PIN_REVOKED");
      const legacyPrompt=typeof definition.systemPrompt==="string"?definition.systemPrompt:"";
      const soul=facts.source.soul_content===null?legacyPrompt:verifyAgentSoul({
        content:facts.source.soul_content,hash:facts.source.soul_hash??""},legacyPrompt).content;
      const attempt=attemptId?r.attempt(id,attemptId):r.latestAttempt(id);
      if(attemptId&&!attempt)throw new StorageError("DIRECT_ATTEMPT_UNAVAILABLE");
      return {sessionId:id,agentVersionId:s.agent_version_id!,assignmentVersionId:s.assignment_version_id!,
        configHash:s.resolved_config_hash!,scopeHash:hash(scope).slice(7),modelId:definition.modelId,
        systemPrompt:soul,
        attemptId:attempt?.id??null,repository:null as null|{aggregateHash:string;
          status:"read"|"missing";files:{path:string;hash:string;bytes:number}[];
          sourceRevision:string;sourceSnapshotId:string;
          workspaceBindingId:string}};
    });
    if(!this.repositoryInstructions)return pin;
    if(!pin.attemptId)throw new StorageError("REPOSITORY_PIN_UNAVAILABLE");
    const snapshot=this.repositoryInstructions.read(id,pin.attemptId);
    return {...pin,systemPrompt:composeDirectStaticPrefix(pin.systemPrompt,snapshot),
      repository:{aggregateHash:snapshot.aggregateHash,status:snapshot.status,
        files:snapshot.files.map(f=>({path:f.path,hash:f.hash,bytes:f.bytes})),
        sourceRevision:snapshot.sourceRevision,
        sourceSnapshotId:snapshot.sourceSnapshotId,workspaceBindingId:snapshot.workspaceBindingId}};
  }
  rename(header:LocalCommandHeader,id:string,rawTitle:string) {
    id=LocalIdSchema.parse(id);const name=title(rawTitle);
    return this.mutate(header,"direct.rename",{id,title:name},r=>{
      this.live(r,id);r.rename(id,name,this.now());return id;
    });
  }
  archive(header:LocalCommandHeader,id:string) { return this.transition(header,id,"active","archived"); }
  restore(header:LocalCommandHeader,id:string) { return this.transition(header,id,"archived","active"); }
  private transition(header:LocalCommandHeader,id:string,from:"active"|"archived",to:"active"|"archived") {
    id=LocalIdSchema.parse(id);
    return this.mutate(header,`direct.${to}`,{id},r=>{
      const s=this.live(r,id),last=r.latestAttempt(id);
      if (s.lifecycle!==from || (last && !["completed","failed","cancelled"].includes(last.outcome)))
        throw new StorageError("DIRECT_SESSION_STATE_CONFLICT");
      if (to==="active") this.admitted(r,s,true);
      r.lifecycle(id,from,to,this.now());return id;
    });
  }
  /** Reserve under the revision fence before any external effect. Provider deletion
   * must be idempotent: a crash can leave a durable pending reservation for retry. */
  async delete(header:LocalCommandHeader,id:string,deleteProvider:DeleteDirectProvider) {
    id=LocalIdSchema.parse(id);
    const inFlight=deleteInFlight.get(this.store)!;
    if (inFlight.has(id)) throw new StorageError("DIRECT_SESSION_STATE_CONFLICT");
    inFlight.add(id);
    try {
      const reserved=this.mutate(header,"direct.delete.reserve",{id},r=>{
        const s=this.live(r,id,true),last=r.latestAttempt(id);
        if (last && !["completed","failed","cancelled"].includes(last.outcome))
          throw new StorageError("DIRECT_SESSION_STATE_CONFLICT");
        if (s.deletion_state==="ready") r.reserveDelete(id,this.now());
        return id;
      });
      const state=this.read(r=>r.session(id));
      if (state?.deleted_at!==null) {
        if (reserved.replayed && state?.deleted_at) return reserved;
        throw new StorageError("DIRECT_SESSION_UNAVAILABLE");
      }
      const refs=this.read(r=>r.providerCleanupAttempts(id));
      for (const attempt of refs) {
        // The operation key is stable across a new delete request and a host
        // incarnation. Never key cleanup to the retrying command or current owner.
        const storedOwner=JSON.parse(attempt.runtime_owner_json) as {
          engine:unknown;instanceId:unknown;epoch:unknown};
        if (storedOwner.engine!=="local") throw new StorageError("DIRECT_PROVIDER_UNAVAILABLE");
        const pin={orgId:this.context.org_id,projectId:this.context.project_id,
          sessionId:id,attemptId:attempt.id,attemptNumber:attempt.attempt_number,
          providerExecutionRef:attempt.provider_execution_ref!,
          runtimeOwner:RuntimeOwnerSchema.parse({engine:storedOwner.engine,
            instance_id:storedOwner.instanceId,epoch:storedOwner.epoch}),
          placementBindingId:attempt.execution_placement_binding_id,
          workspaceBindingId:attempt.workspace_binding_id,fencingToken:attempt.fencing_token};
        const result=await deleteProvider({...pin,idempotencyKey:hash({
          operation:"direct.provider.delete.v1",...pin})});
        if (result!=="deleted" && result!=="already_absent")
          throw new StorageError("DIRECT_PROVIDER_UNAVAILABLE");
      }
      // A revision of an unrelated Session may race the final commit. The
      // durable pending marker blocks this Session until finalization succeeds.
      for (let retry=0;retry<4;retry++) {
        try {
          this.mutate({...header,...this.authority(),request_id:randomUUID(),
            idempotency_key:randomUUID()},"direct.delete.finalize",{id},r=>{
            const s=this.live(r,id,true);
            if (s.deletion_state!=="pending") throw new StorageError("DIRECT_SESSION_STATE_CONFLICT");
            r.tombstone(id,this.now());return id;
          });
          return {...reserved,replayed:false};
        } catch(error) {
          if (!(error instanceof StorageError) || error.code!=="REVISION_CONFLICT" || retry===3) throw error;
        }
      }
      throw new StorageError("REVISION_CONFLICT");
    } finally { inFlight.delete(id); }
  }
  /** A trusted adapter supplies a fresh binding before its first side effect. */
  startAttempt(header:LocalCommandHeader,id:string,raw:DirectExecutionBinding,
    source?:RepositoryInstructionSource) {
    id=LocalIdSchema.parse(id);
    const binding={placementBindingId:LocalIdSchema.parse(raw.placementBindingId),
      workspaceBindingId:LocalIdSchema.parse(raw.workspaceBindingId),
      sourceRevision:LocalIdSchema.parse(raw.sourceRevision),
      fencingToken:LocalIdSchema.parse(raw.fencingToken),
      providerExecutionRef:raw.providerExecutionRef===null?null:LocalIdSchema.parse(raw.providerExecutionRef)};
    if(this.repositoryInstructions&&!source)throw new StorageError("REPOSITORY_SOURCE_REQUIRED");
    if(source&&!this.repositoryInstructions)throw new StorageError("REPOSITORY_SOURCE_UNAVAILABLE");
    const attemptId=randomUUID();
    // The host proves the authorized binding before any path is read. The
    // transaction repeats this check after discovery to reject admission races.
    if(source) this.read(r=>{
      const s=this.live(r,id);this.admitted(r,s);
      if(!this.verifyBinding(this.context,s,binding))throw new StorageError("DIRECT_BINDING_UNAVAILABLE");
    });
    // D3B's binding.sourceRevision currently names the Agent version. The
    // repository source revision is a separate host attestation in this pin.
    if(source&&source.workspaceBindingId!==binding.workspaceBindingId)
      throw new StorageError("REPOSITORY_SOURCE_INVALID");
    const prepared=source?this.repositoryInstructions!.prepare(source,id,attemptId):null;
    return this.mutate(header,"direct.attempt.start",{id,binding,
      repositoryHash:prepared?.snapshot.aggregateHash??null},(r,tx)=>{
      const s=this.live(r,id),{authorityHash}=this.admitted(r,s),last=r.latestAttempt(id);
      if (last && !["completed","failed","cancelled"].includes(last.outcome))
        throw new StorageError("DIRECT_ATTEMPT_STATE_CONFLICT");
      if (binding.sourceRevision!==s.agent_version_id || !this.verifyBinding(this.context,s,binding))
        throw new StorageError("DIRECT_BINDING_UNAVAILABLE");
      // A distinct writable instance is mandatory, even for successive attempts.
      const seen=r.workspaceBindingUsed(binding.workspaceBindingId);
      if (seen) throw new StorageError("DIRECT_WORKSPACE_REUSED");
      r.insertAttempt({id:attemptId,sessionId:id,number:(last?.attempt_number??0)+1,
        placementId:binding.placementBindingId,workspaceId:binding.workspaceBindingId,
        sourceRevision:binding.sourceRevision,ownerJson:JSON.stringify({engine:"local",
          instanceId:this.store.owner.instance_id,epoch:this.store.owner.epoch}),
        fence:binding.fencingToken,authorityHash,configHash:s.resolved_config_hash!,
        accountingId:attemptId,providerRef:binding.providerExecutionRef,now:this.now()});
      if(prepared)this.repositoryInstructions!.pin(tx,id,attemptId,prepared);
      return attemptId;
    });
  }
  /** A5D's host-only transaction seam. Replay may consume an already settled
   * result after an incarnation change, but can never authorize new I/O. */
  withProviderAttempt<T>(sessionId:string,attemptId:string,binding:DirectExecutionBinding,
    mode:"dispatch"|"replay",work:(tx:SqliteUnit,pin:{sessionId:string;attemptId:string;
      agentId:string;agentVersionId:string;assignmentVersionId:string;authorityHash:string;
      configHash:string;budget:ReturnType<DirectSessionRepository["released"]>["budget"];
      assignmentBudget:{modelTokens:number;costUsd:number}})=>T):T {
    sessionId=LocalIdSchema.parse(sessionId);attemptId=LocalIdSchema.parse(attemptId);
    return this.read((r,tx)=>{
      const s=this.live(r,sessionId),a=r.attempt(sessionId,attemptId);
      if (!a || (mode==="dispatch" ? !["running","waiting"].includes(a.outcome)
        : !["running","waiting","completed"].includes(a.outcome)))
        throw new StorageError("DIRECT_ATTEMPT_UNAVAILABLE");
      const {authorityHash,facts}=this.admitted(r,s);
      if (a.effective_authority_hash!==authorityHash || a.resolved_config_hash!==s.resolved_config_hash
        || (mode==="dispatch" && a.runtime_owner_json!==JSON.stringify({engine:"local",instanceId:this.store.owner.instance_id,epoch:this.store.owner.epoch}))
        || a.execution_placement_binding_id!==binding.placementBindingId
        || a.workspace_binding_id!==binding.workspaceBindingId
        || a.source_revision_or_snapshot!==binding.sourceRevision
        || a.fencing_token!==binding.fencingToken
        || a.provider_execution_ref!==binding.providerExecutionRef
        || (mode==="dispatch" && !this.verifyBinding(this.context,s,binding)))
        throw new StorageError("DIRECT_BINDING_UNAVAILABLE");
      return work(tx,{sessionId,attemptId,agentId:s.agent_id,agentVersionId:s.agent_version_id!,
        assignmentVersionId:s.assignment_version_id!,authorityHash,configHash:s.resolved_config_hash!,
        budget:facts.budget,assignmentBudget:{modelTokens:facts.contract.budgetCeilings.modelTokens!,
          costUsd:facts.contract.budgetCeilings.costUsd!}});
    });
  }
  /** Called immediately before model dispatch or context injection. */
  assertDispatch(sessionId:string,attemptId:string,binding:DirectExecutionBinding,
    memory:readonly unknown[]=[]) {
    return this.withProviderAttempt(sessionId,attemptId,binding,"dispatch",(_tx,pin)=>{
      // No Memory source is connected in D3B; an unverified candidate never enters a prompt.
      if (!Array.isArray(memory) || memory.length!==0) throw new StorageError("DIRECT_MEMORY_UNAVAILABLE");
      return {sessionId,attemptId,agentVersionId:pin.agentVersionId,
        assignmentVersionId:pin.assignmentVersionId,memory:[] as readonly never[]};
    });
  }
  outcome(header:LocalCommandHeader,sessionId:string,attemptId:string,to:"waiting"|"running"|"completed"|"failed"|"cancelled") {
    sessionId=LocalIdSchema.parse(sessionId);attemptId=LocalIdSchema.parse(attemptId);
    return this.mutate(header,"direct.attempt.outcome",{sessionId,attemptId,to},r=>{
      this.live(r,sessionId);
      const a=r.attempt(sessionId,attemptId);
      if (!a) throw new StorageError("DIRECT_ATTEMPT_UNAVAILABLE");
      if (a.runtime_owner_json!==JSON.stringify({engine:"local",instanceId:this.store.owner.instance_id,epoch:this.store.owner.epoch}))
        throw new StorageError("DIRECT_BINDING_UNAVAILABLE");
      r.outcome(sessionId,attemptId,a.outcome,to);return attemptId;
    });
  }
  /** Host loss alone leaves the attempt uncertain. Only a trusted proof that
   * the old provider execution stopped can close it and unlock a new binding. */
  recover(header:LocalCommandHeader,sessionId:string,attemptId:string,raw:DirectStopProof) {
    sessionId=LocalIdSchema.parse(sessionId);attemptId=LocalIdSchema.parse(attemptId);
    const proof={workspaceBindingId:LocalIdSchema.parse(raw.workspaceBindingId),
      providerExecutionRef:raw.providerExecutionRef===null?null:LocalIdSchema.parse(raw.providerExecutionRef),
      stopToken:LocalIdSchema.parse(raw.stopToken)};
    return this.mutate(header,"direct.attempt.recover",{sessionId,attemptId,proof},r=>{
      const s=this.live(r,sessionId);
      const a=r.attempt(sessionId,attemptId);
      if (!a || !["running","waiting"].includes(a.outcome)
        || a.runtime_owner_json===JSON.stringify({engine:"local",instanceId:this.store.owner.instance_id,
          epoch:this.store.owner.epoch})) throw new StorageError("DIRECT_RECOVERY_UNAVAILABLE");
      if (a.workspace_binding_id!==proof.workspaceBindingId
        || a.provider_execution_ref!==proof.providerExecutionRef
        || !this.verifyStopped(this.context,s,a,proof)) throw new StorageError("DIRECT_RECOVERY_UNAVAILABLE");
      r.outcome(sessionId,attemptId,a.outcome,"cancelled");return attemptId;
    });
  }
}
