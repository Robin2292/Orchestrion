import { createHash } from "node:crypto";
import { z } from "zod";
import { ConnectorRepository } from "../connectors/repository";
import type { HostConnectorHttpService } from "../connectors/http-service";
import type { LocalConnector } from "../shared/connector-contracts";
import { JobEventBus } from "../jobs/event-bus";
import { ToolGrantRepository } from "../grants/repository";
import { LocalCommandHeaderSchema, LocalContextSchema, type LocalCommandHeader, type LocalContext } from "../shared/local-contracts";
import { canonical, parseCanonical, type Json } from "../shared/policy/p0-canonical";
import { SourceCandidateSchema, SourceConnectorPinSchema, SourceDraftInputSchema, SourceIdentitySchema,
  SourceReleaseInputSchema, SourceActivateInputSchema, SourceSnapshotSchema, SourcePublicationSchema,
  SourceReadinessSchema, SourceContractPinSchema, type SourceCandidate, type SourceSnapshot } from "../shared/source-publication-contracts";
import { toolJson, toolDigest } from "../tools/registry";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { SourceRepository, SOURCE_FENCE } from "./repository";

/** A synchronous host preflight. It is deliberately not serializable or accepted
 * from IPC: the discovery owner supplies it before a fenced SQLite transaction. */
export interface PublishedSourcePolicyPreflight {
  readonly sourceId: string;
  readonly key: string;
  readonly candidate: SourceCandidate;
}

export interface SourceDiscoveryAuthority {
  /** A trusted host reader, never an IPC/model supplied proof. */
  candidate(connectorId:string,revision:number): unknown;
  /** P1 binding needs C1's currently reviewed profile, not merely a stored
   * accepted candidate. Legacy discovery fixtures without this remain Not Ready. */
  reviewedProfile?(connectorId:string,revision:number):boolean;
  /** Pure C1 check against the current Connector row in the caller's transaction. */
  reviewedProfileForConnector?(connector:LocalConnector):boolean;
}
/** C1's transient candidate is consumed only while its own freshness and
 * credential checks pass. It is never restored from an old renderer response. */
export function httpSourceDiscovery(http: Pick<HostConnectorHttpService,"projection"|"reviewedProfileForConnector">): SourceDiscoveryAuthority {
  return { reviewedProfile(connectorId,revision) {
    const result=http.projection({id:connectorId,revision});
    return result.ok && result.value.status==="candidate";
  }, reviewedProfileForConnector(connector) {
    return http.reviewedProfileForConnector(connector);
  }, candidate(connectorId,revision) {
    const result=http.projection({ id:connectorId,revision });
    if (!result.ok || result.value.status!=="candidate") throw new StorageError("SOURCE_DISCOVERY_NOT_READY");
    return { connectorId,connectorRevision:revision,adapterKind:"http",status:"candidate",
      tools:result.value.tools.map(t => ({ key:t.name,inputSchema:t.inputSchema,outputSchema:t.outputSchema })) };
  } };
}
const hash=(value:unknown) => `sha256:${createHash("sha256").update(canonical(value as Json)).digest("hex")}`;
const COMPILER_VERSION="c3a-tool-schema-v1" as const;

/** C3A is publication authority, never adapter execution authority. */
export class LocalSourcePublicationService {
  readonly events=new JobEventBus();
  readonly #context: LocalContext;
  constructor(private readonly store:SqliteFoundation,context:LocalContext,private readonly discovery:SourceDiscoveryAuthority,
    private readonly clock=()=>new Date()) {
    this.#context=LocalContextSchema.parse(context);
    this.read(r => r.ensureFence());
  }
  get context() { return structuredClone(this.#context); }
  private read<T>(work:(r:SourceRepository,tx:SqliteUnit)=>T):T {
    return this.store.transaction(tx => { const r=new SourceRepository(tx,this.context); r.authorize(); return work(r,tx); });
  }
  authority() { return { context:this.context,runtime_owner:this.store.owner,expected:this.read(r=>r.pin()),run:null }; }
  private parse<S extends z.ZodTypeAny>(schema:S,raw:unknown):z.infer<S> {
    try { const bytes=toolJson(raw), value=schema.parse(parseCanonical(bytes));
      if (canonical(value)!==bytes) throw new Error(); return value;
    } catch { throw new StorageError("INVALID_PAYLOAD"); }
  }
  private mutate(header:LocalCommandHeader,command:string,payload:unknown,
    preflight:()=>SourceCandidate,work:(r:SourceRepository,tx:SqliteUnit,candidate:SourceCandidate)=>string) {
    const h=this.parse(LocalCommandHeaderSchema,header);
    if (h.run!==null) throw new StorageError("INVALID_PAYLOAD");
    this.read(r=>r.authorize(true)); // also on exact replay
    // C1's projection performs its own SQLite reads. Run it before F4 opens
    // the write transaction, never from the fenced callback. Both calls are
    // synchronous: no host task can change C1's in-memory candidate between
    // this proof and the SQL pin checks below. F4 still decides exact replay.
    const prior=this.read((_r,tx)=>!!tx.get(`SELECT 1 FROM command_commits WHERE org_id=? AND project_id=?
      AND principal_type=? AND principal_id=? AND command=? AND idempotency_key=?`,
      this.context.org_id,this.context.project_id,this.context.principal.type,this.context.principal.id,command,h.idempotency_key));
    const candidate=prior ? null : preflight();
    const bytes=canonical(payload as Json);
    const result=this.store.commit({ trustedContext:this.context,header:h,command,resourceKey:SOURCE_FENCE,
      canonicalContent:bytes,nextHash:hash([command,payload,h.expected]) },tx => {
      const r=new SourceRepository(tx,this.context); r.authorize(true);
      if (!candidate) throw new StorageError("SOURCE_DISCOVERY_NOT_READY");
      return work(r,tx,candidate);
    });
    if (!result.replayed) this.events.publish();
    return { resultRef:result.resultRef };
  }
  private connector(tx:SqliteUnit,id:string) {
    const repo=new ConnectorRepository(tx,this.context); repo.authorize();
    const connector=repo.get(id);
    if (connector.deletedAt) throw new StorageError("SOURCE_DRIFT");
    return connector;
  }
  private candidate(connectorId:string,revision:number):SourceCandidate {
    let raw:unknown;
    try { raw=this.discovery.candidate(connectorId,revision); }
    catch { throw new StorageError("SOURCE_DISCOVERY_NOT_READY"); }
    try {
      const bytes=toolJson(raw), candidate=SourceCandidateSchema.parse(parseCanonical(bytes));
      if (canonical(candidate as unknown as Json)!==bytes || candidate.connectorId!==connectorId || candidate.connectorRevision!==revision)
        throw new Error();
      return candidate;
    } catch { throw new StorageError("SOURCE_DISCOVERY_NOT_READY"); }
  }
  private candidateForSnapshot(lookup:(r:SourceRepository)=>SourceSnapshot):SourceCandidate {
    const snapshot=this.read(r=>lookup(r));
    return this.candidate(snapshot.sourceId,snapshot.pin.connectorRevision);
  }
  private live(tx:SqliteUnit,snapshot:SourceSnapshot,candidate:SourceCandidate) {
    const connector=this.connector(tx,snapshot.sourceId);
    if (connector.revision!==snapshot.pin.connectorRevision || hash(connector.config)!==snapshot.pin.configHash)
      throw new StorageError("SOURCE_DRIFT");
    const credential=connector.auth.mode==="static" ? connector.auth.credential : null;
    if ((credential?.credential_ref ?? null)!==snapshot.pin.credentialRef
      || (credential?.revision ?? null)!==snapshot.pin.credentialRevision) throw new StorageError("SOURCE_DRIFT");
    if (credential) {
      const row=new ConnectorRepository(tx,this.context).credentials.get({
        connector_id:credential.connector_id,credential_ref:credential.credential_ref });
      if (row.state!=="active" || row.revision!==credential.revision) throw new StorageError("SOURCE_DRIFT");
    }
    if (candidate.connectorId!==connector.id || candidate.connectorRevision!==connector.revision
      || candidate.adapterKind!==snapshot.adapterKind
      || hash([COMPILER_VERSION,snapshot.pin,candidate.adapterKind,candidate.tools])!==snapshot.contentHash)
      throw new StorageError("SOURCE_DRIFT");
    return candidate;
  }
  accept(header:LocalCommandHeader,raw:unknown) {
    const p=this.parse(SourceConnectorPinSchema,raw);
    return this.mutate(header,"source.accept",p,()=>this.candidate(p.connectorId,p.revision),(r,tx,candidate) => {
      const connector=this.connector(tx,p.connectorId);
      if (connector.revision!==p.revision) throw new StorageError("SOURCE_DRIFT");
      if (candidate.connectorId!==connector.id || candidate.connectorRevision!==connector.revision)
        throw new StorageError("SOURCE_DRIFT");
      const credential=connector.auth.mode==="static" ? connector.auth.credential : null;
      if (credential) {
        const row=new ConnectorRepository(tx,this.context).credentials.get({
          connector_id:credential.connector_id,credential_ref:credential.credential_ref });
        if (row.state!=="active" || row.revision!==credential.revision) throw new StorageError("SOURCE_DRIFT");
      }
      const pin={ connectorId:connector.id,connectorRevision:connector.revision,configHash:hash(connector.config),
        credentialRef:credential?.credential_ref ?? null,credentialRevision:credential?.revision ?? null };
      const snapshot=SourceSnapshotSchema.parse({ schemaVersion:"orchestrion.local.source-snapshot.v1",compilerVersion:COMPILER_VERSION,id:header.request_id,
        context:this.context,sourceId:connector.id,connectionId:connector.id,pin,adapterKind:candidate.adapterKind,
        tools:candidate.tools,contentHash:hash([COMPILER_VERSION,pin,candidate.adapterKind,candidate.tools]),acceptedAt:this.clock().toISOString() });
      r.insertSnapshot(snapshot); return snapshot.id;
    });
  }
  createDraft(header:LocalCommandHeader,raw:unknown) {
    const p=this.parse(SourceDraftInputSchema,raw);
    return this.mutate(header,"source.draft",p,()=>this.candidateForSnapshot(r=>r.snapshot(p.snapshotId)),(r,tx,candidate) => {
      const snapshot=r.snapshot(p.snapshotId);
      if (r.latestSnapshot(snapshot.sourceId)?.id!==snapshot.id) throw new StorageError("SOURCE_DRIFT");
      this.live(tx,snapshot,candidate);
      r.insertDraft(p.id,snapshot,this.clock().toISOString()); return p.id;
    });
  }
  review(header:LocalCommandHeader,raw:unknown) {
    const p=this.parse(SourceIdentitySchema,raw);
    return this.mutate(header,"source.review",p,()=>this.candidateForSnapshot(r=>r.snapshot(r.draft(p.id).snapshotId)),(r,tx,candidate) => {
      const draft=r.draft(p.id), snapshot=r.snapshot(draft.snapshotId);
      if (r.latestSnapshot(snapshot.sourceId)?.id!==snapshot.id) throw new StorageError("SOURCE_DRIFT");
      this.live(tx,snapshot,candidate);
      r.review(p.id,snapshot.contentHash,this.clock().toISOString()); return p.id;
    });
  }
  publish(header:LocalCommandHeader,raw:unknown) {
    const p=this.parse(SourceReleaseInputSchema,raw);
    return this.mutate(header,"source.publish",p,()=>this.candidateForSnapshot(r=>r.snapshot(r.draft(p.draftId).snapshotId)),(r,tx,candidate) => {
      const draft=r.draft(p.draftId), snapshot=r.snapshot(draft.snapshotId);
      if (draft.reviewedHash!==snapshot.contentHash || r.latestSnapshot(snapshot.sourceId)?.id!==snapshot.id)
        throw new StorageError("SOURCE_REVIEW_REQUIRED");
      this.live(tx,snapshot,candidate);
      const tools=snapshot.tools.map(t => {
        const body={ schemaVersion:"orchestrion.local.published-tool.v1",sourceId:snapshot.sourceId,
          connectionId:snapshot.connectionId,releaseId:p.id,adapterKind:snapshot.adapterKind,
          key:t.key,inputSchema:t.inputSchema,outputSchema:t.outputSchema };
        return { sourceId:snapshot.sourceId,connectionId:snapshot.connectionId,key:t.key,
          contractId:toolDigest([p.id,t.key]).slice(7),ownerKey:`connection:${toolDigest([snapshot.sourceId,snapshot.connectionId]).slice(7)}`,
          contractHash:toolDigest(body),schemaHash:toolDigest(t.inputSchema),
          inputSchema:t.inputSchema,outputSchema:t.outputSchema };
      });
      const publication=SourcePublicationSchema.parse({ schemaVersion:"orchestrion.local.source-publication.v1",compilerVersion:COMPILER_VERSION,id:p.id,
        context:this.context,sourceId:snapshot.sourceId,connectionId:snapshot.connectionId,version:r.nextVersion(snapshot.sourceId),
        snapshotId:snapshot.id,snapshotHash:snapshot.contentHash,pin:snapshot.pin,adapterKind:snapshot.adapterKind,
        tools,
        publishedAt:this.clock().toISOString() });
      r.insertRelease(publication,p.draftId);
      const grants=new ToolGrantRepository(tx,this.context);
      for (const t of publication.tools) grants.registerContract({ context:this.context,tool:{source:t.sourceId,key:t.key},
        anchor:{ org_id:this.context.org_id,owner_key:t.ownerKey,tool_name:t.key,
          tool_contract_version_id:t.contractId,tool_contract_hash:t.contractHash },schema_hash:t.schemaHash,
        contract_json:toolJson({ schemaVersion:"orchestrion.local.published-tool.v1",sourceId:t.sourceId,
          connectionId:t.connectionId,releaseId:p.id,adapterKind:snapshot.adapterKind,
          key:t.key,inputSchema:t.inputSchema,outputSchema:t.outputSchema }) });
      return p.id;
    });
  }
  activate(header:LocalCommandHeader,raw:unknown) {
    const p=this.parse(SourceActivateInputSchema,raw);
    return this.mutate(header,"source.activate",p,()=>this.candidateForSnapshot(r=>r.snapshot(r.release(p.releaseId).snapshotId)),(r,tx,candidate) => {
      const release=r.release(p.releaseId), snapshot=r.snapshot(release.snapshotId);
      if (release.snapshotHash!==snapshot.contentHash || r.latestSnapshot(release.sourceId)?.id!==snapshot.id)
        throw new StorageError("SOURCE_DRIFT");
      this.live(tx,snapshot,candidate);
      if (r.active(release.sourceId)?.releaseId===release.id) throw new StorageError("SOURCE_ALREADY_ACTIVE");
      r.activate(release,this.clock().toISOString()); return release.id;
    });
  }
  rollback(header:LocalCommandHeader,raw:unknown) {
    const p=this.parse(SourceActivateInputSchema,raw);
    return this.mutate(header,"source.rollback",p,()=>this.candidateForSnapshot(r=>r.snapshot(r.release(p.releaseId).snapshotId)),(r,tx,candidate) => {
      const release=r.release(p.releaseId), current=r.active(release.sourceId);
      if (!current || current.releaseId===release.id || r.release(current.releaseId).version<=release.version)
        throw new StorageError("SOURCE_ROLLBACK_INVALID");
      const snapshot=r.snapshot(release.snapshotId);
      if (release.snapshotHash!==snapshot.contentHash) throw new StorageError("SOURCE_DRIFT");
      this.live(tx,snapshot,candidate); // rollback may return to older accepted content only if live again
      r.activate(release,this.clock().toISOString()); return release.id;
    });
  }
  snapshot(raw:unknown) { const p=this.parse(SourceIdentitySchema,raw); return this.read(r=>r.snapshot(p.id)); }
  publication(raw:unknown) { const p=this.parse(SourceIdentitySchema,raw); return this.read(r=>r.release(p.id)); }
  readiness(raw:unknown) {
    const p=this.parse(SourceConnectorPinSchema,raw);
    const activeSnapshot=this.read(r=>{ const active=r.active(p.connectorId);
      return active ? r.snapshot(r.release(active.releaseId).snapshotId) : null; });
    let candidate:SourceCandidate|null=null;
    if (activeSnapshot) {
      try { candidate=this.candidate(activeSnapshot.sourceId,activeSnapshot.pin.connectorRevision); }
      catch { /* current C1 discovery is unavailable */ }
    }
    return this.read((r,tx) => {
      const latest=r.latestSnapshot(p.connectorId), release=r.latestRelease(p.connectorId), active=r.active(p.connectorId);
      const accepted=!!latest,published=!!release;
      let connectionReady=false;
      let adapterKind=latest?.adapterKind;
      if (active) {
        try { const activeRelease=r.release(active.releaseId), snapshot=r.snapshot(activeRelease.snapshotId);
          adapterKind=snapshot.adapterKind;
          if (candidate && snapshot.pin.connectorRevision===p.revision) {
            this.live(tx,snapshot,candidate);connectionReady=snapshot.adapterKind==="http";
          }
        } catch { /* typed Not Ready */ }
      }
      const reason=!accepted ? "SOURCE_NOT_ACCEPTED" : !published ? "SOURCE_NOT_PUBLISHED"
        : !active ? "SOURCE_NOT_ACTIVE" : !connectionReady ? adapterKind!=="http" ? "SOURCE_ADAPTER_NOT_READY" : "SOURCE_DRIFT"
          : "SOURCE_EXECUTION_NOT_READY";
      return SourceReadinessSchema.parse({ accepted,published,connectionReady,executionReady:false,activeReleaseId:active?.releaseId ?? null,reason });
    });
  }
  /** Effect-time admission seam for later reviewed adapters. C3A never returns a
   * callable; a current contract proof still has executionReady=false. */
  assertActiveContract(raw:unknown) {
    const p=this.parse(SourceContractPinSchema,raw);
    const candidate=this.candidateForSnapshot(r=>{ const active=r.active(p.sourceId);
      if (!active) throw new StorageError("SOURCE_NOT_ACTIVE");
      return r.snapshot(r.release(active.releaseId).snapshotId);
    });
    return this.read((r,tx) => {
      const active=r.active(p.sourceId);
      if (!active) throw new StorageError("SOURCE_NOT_ACTIVE");
      const release=r.release(active.releaseId), snapshot=r.snapshot(release.snapshotId);
      if (release.sourceId!==p.sourceId || release.snapshotHash!==snapshot.contentHash ||
        !release.tools.some(t=>t.contractId===p.contractId && t.contractHash===p.contractHash))
        throw new StorageError("SOURCE_DRIFT");
      this.live(tx,snapshot,candidate);
      return { publication:release,executionReady:false as const };
    });
  }

  /** D2E2P configuration binding. Discovery may open its own transaction, so it
   * runs first; the final authority check is repeated in the caller's SQLite
   * transaction without any await or separate read. */
  preparePolicyContract(sourceId:string,key:string):PublishedSourcePolicyPreflight {
    const snapshot=this.read(r => {
      const active=r.active(sourceId);
      if (!active) throw new StorageError("SOURCE_NOT_ACTIVE");
      return r.snapshot(r.release(active.releaseId).snapshotId);
    });
    let reviewed=false;
    try { reviewed=this.discovery.reviewedProfile?.(snapshot.sourceId,snapshot.pin.connectorRevision)===true; }
    catch { /* unknown profile is Not Ready */ }
    if (!reviewed) throw new StorageError("SOURCE_PROFILE_NOT_READY");
    const candidate=this.candidate(snapshot.sourceId,snapshot.pin.connectorRevision);
    return { sourceId,key,candidate };
  }
  revalidatePolicyContract(tx:SqliteUnit,preflight:PublishedSourcePolicyPreflight) {
    const { sourceId,key,candidate }=preflight;
    const r=new SourceRepository(tx,this.context); r.authorize();
    const active=r.active(sourceId);
    if (!active) throw new StorageError("SOURCE_NOT_ACTIVE");
    const release=r.release(active.releaseId),snapshot=r.snapshot(release.snapshotId);
    if (r.latestRelease(sourceId)?.id!==release.id || r.latestSnapshot(sourceId)?.id!==snapshot.id
      || release.sourceId!==sourceId || release.snapshotHash!==snapshot.contentHash)
      throw new StorageError("SOURCE_DRIFT");
    if (snapshot.adapterKind!=="http" || release.adapterKind!=="http")
      throw new StorageError("SOURCE_ADAPTER_NOT_READY");
    this.live(tx,snapshot,candidate);
    let reviewed=false;
    try { reviewed=this.discovery.reviewedProfileForConnector?.(this.connector(tx,sourceId))===true; }
    catch { /* unknown live profile is Not Ready */ }
    if (!reviewed) throw new StorageError("SOURCE_PROFILE_NOT_READY");
    const tool=release.tools.find(t=>t.key===key);
    if (!tool) throw new StorageError("SOURCE_DRIFT");
    const expected={ org_id:this.context.org_id,owner_key:tool.ownerKey,tool_name:key,
      tool_contract_version_id:tool.contractId,tool_contract_hash:tool.contractHash };
    const row=tx.get(`SELECT source_namespace,tool_key,contract_hash,schema_hash,anchor_json,contract_json
      FROM local_tool_contract_versions WHERE org_id=? AND project_id=? AND principal_type=? AND principal_id=?
      AND id=?`,this.context.org_id,this.context.project_id,this.context.principal.type,this.context.principal.id,tool.contractId);
    const body={ schemaVersion:"orchestrion.local.published-tool.v1",sourceId,connectionId:release.connectionId,
      releaseId:release.id,adapterKind:"http",key,inputSchema:tool.inputSchema,outputSchema:tool.outputSchema };
    if (!row || row.source_namespace!==sourceId || row.tool_key!==key
      || row.contract_hash!==tool.contractHash || row.schema_hash!==tool.schemaHash
      || row.anchor_json!==toolJson(expected) || row.contract_json!==toolJson(body)
      || tool.schemaHash!==toolDigest(tool.inputSchema) || tool.contractHash!==toolDigest(body))
      throw new StorageError("TOOL_SCHEMA_DRIFT");
    return { sourceReleaseId:release.id,sourceActivationRevision:active.revision,
      sourceId,connectionId:release.connectionId,connectorId:release.sourceId,
      contractId:tool.contractId,contractHash:tool.contractHash,schemaHash:tool.schemaHash,
      anchor:expected,executionReady:false as const };
  }
}
