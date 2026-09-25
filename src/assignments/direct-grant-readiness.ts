import { z } from "zod";
import { LocalDirectGrantCeilingService } from "../direct-grant-ceilings/service";
import { grantDigest, grantSetDigest, ToolGrantRepository } from "../grants/repository";
import { publishedSourcePolicyName, publishedSourcePolicyService } from "../policies/service";
import { PolicyRepository, POLICY_FENCE } from "../policies/repository";
import { LocalFolderIdentitySchema } from "../shared/execution-attempt-contracts";
import { snapshotProjectRoot, snapshotProjectRootSync } from "../main/workspace-files";
import { AgentDefinitionSchema } from "../shared/agent-contracts";
import { LocalContextSchema, LocalIdSchema, type LocalContext } from "../shared/local-contracts";
import { grantCanonicalJson, normalizeToolGrants, serializeToolGrants, type ToolGrant } from "../shared/tool-grant-contracts";
import { LocalSourcePublicationService } from "../sources/service";
import { SourceRepository } from "../sources/repository";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { ToolRegistry } from "../tools/registry";
import { LocalAssignmentRepository } from "./repository";

const RequestSchema=z.object({ assignmentId:LocalIdSchema,agentVersionId:LocalIdSchema,
  principalVersionIds:z.array(LocalIdSchema).min(1).max(32) }).strict();
type Request=z.infer<typeof RequestSchema>;
export type DirectGrantNotReadyReason="ASSIGNMENT_NOT_READY"|"AGENT_VERSION_NOT_READY"|
  "CEILING_NOT_READY"|"GRANT_MISMATCH"|"TOOL_CONTRACT_NOT_READY"|"SOURCE_NOT_READY"|
  "POLICY_NOT_READY"|"POLICY_DENIED"|"POLICY_APPROVAL_REQUIRED"|"WORKSPACE_NOT_READY";
export type DirectGrantReadyProof={
  state:"ready";assignmentId:string;agentVersionId:string;agentPrincipalId:string;
  targetProjectId:string;sourceProjectId:string;workspaceHash:string;
  organizationRevision:number;principalRevision:number;organizationCeilingHash:string;
  principalGrantHash:string;agentVersionGrantHash:string;
  selected:readonly {
    principalVersionId:string;parentOrganizationVersionId:string;tupleHash:string;
    sourceId:string;sourceReleaseId:string;sourceActivationRevision:number;
    contractId:string;contractHash:string;schemaHash:string;connectionId:string;
    connectionAuthorityHash:string;connectorRevision:number;connectorConfigHash:string;
    credentialRevision:number|null;
    policyId:string;policyHash:string;policyStateRevision:number;policySelectionSequence:number;
    ancestorPolicies:readonly {id:string;releaseHash:string;stateRevision:number;selectionSequence:number}[];
  }[];
  executionReady:false;grantsAuthority:false;
};
export type DirectGrantReadiness=DirectGrantReadyProof|{state:"not_ready";reason:DirectGrantNotReadyReason;
  executionReady:false;grantsAuthority:false};

type Selected={versionId:string;parentId:string;grant:ToolGrant;
  grantPolicyId:string;grantPolicyHash:string;
  connectorRevision:number;connectorConfigHash:string;credentialRevision:number|null;
  policyPin:{id:string;releaseHash:string;stateRevision:number;selectionSequence:number};
  sourcePin:{sourceId:string;releaseId:string;contractId:string;contractHash:string;schemaHash:string};};
type Snapshot={assignmentId:string;agentVersionId:string;agentPrincipalId:string;
  targetProjectId:string;sourceProjectId:string;workspaceHash:string;workspacePath:string;
  organizationRevision:number;principalRevision:number;organizationHash:string;principalHash:string;
  agentVersionHash:string;selected:Selected[]};

function notReady(code:DirectGrantNotReadyReason):never { throw new StorageError(code); }
function reason(error:unknown):DirectGrantNotReadyReason {
  if (error instanceof z.ZodError) return "GRANT_MISMATCH";
  const code=error instanceof StorageError ? error.code : "";
  if (code==="ASSIGNMENT_NOT_READY" || code.startsWith("ASSIGNMENT_") || code==="NOT_AUTHENTICATED") return "ASSIGNMENT_NOT_READY";
  if (code==="AGENT_VERSION_NOT_READY" || code.startsWith("AGENT_")) return "AGENT_VERSION_NOT_READY";
  if (code==="CEILING_NOT_READY" || code.startsWith("DIRECT_GRANT_")) return "CEILING_NOT_READY";
  if (code==="GRANT_MISMATCH" || code==="INVALID_PAYLOAD") return "GRANT_MISMATCH";
  if (code==="WORKSPACE_NOT_READY") return "WORKSPACE_NOT_READY";
  if (code==="POLICY_DENIED" || code==="POLICY_APPROVAL_REQUIRED") return code;
  if (code.startsWith("POLICY_")) return "POLICY_NOT_READY";
  if (code.startsWith("SOURCE_") || code.startsWith("CONNECTOR_") || code.startsWith("CREDENTIAL_")) return "SOURCE_NOT_READY";
  return "TOOL_CONTRACT_NOT_READY";
}

/** Host-only D2E3 proof. The prepared object is single-use and has no dispatch or
 * release authority. D2E4 must prepare it after awaits and call check(tx) inside
 * the same fenced SQLite transaction as its immutable release. */
export class LocalDirectGrantReadinessService {
  readonly context:LocalContext;
  constructor(private readonly store:SqliteFoundation,context:LocalContext,
    private readonly source:LocalSourcePublicationService,private readonly registry:ToolRegistry) {
    this.context=LocalContextSchema.parse(context);
    if (grantCanonicalJson(this.context)!==grantCanonicalJson(source.context))
      throw new StorageError("CONTEXT_MISMATCH");
  }
  private snapshot(tx:SqliteUnit,p:Request):Snapshot {
    const r=new LocalAssignmentRepository(tx,this.context);r.authorize();
    const assignment=r.assignment(p.assignmentId);
    if (!assignment || assignment.status!=="active" || assignment.migration_state!=="governed")
      return notReady("ASSIGNMENT_NOT_READY");
    const agent=r.catalogIdentity(assignment.agent_id);
    if (!agent || agent.agent_principal_id!==agent.id || agent.removed_at!==null)
      return notReady("AGENT_VERSION_NOT_READY");
    // TG1, P1, C3A and F5 rows are Project-local. No cross-Project sharing
    // authority exists yet, even for an organization-visible Agent identity.
    if (agent.home_project_id!==this.context.project_id) return notReady("SOURCE_NOT_READY");
    const version=r.sourceVersion(agent,p.agentVersionId);
    if (!version) return notReady("AGENT_VERSION_NOT_READY");
    const definition=AgentDefinitionSchema.parse(JSON.parse(version.definition_json));
    const projection=new ToolGrantRepository(tx,this.context);
    const projected=projection.agent(agent.id,p.agentVersionId);
    if (!definition.toolGrants || !projected ||
      serializeToolGrants(definition.toolGrants)!==serializeToolGrants(projected))
      return notReady("GRANT_MISMATCH");
    projection.validate(projected);
    const ceilings=LocalDirectGrantCeilingService.resolveForAssignment(tx,this.context,
      p.assignmentId,this.context.project_id);
    if (ceilings.agentPrincipalId!==agent.id) return notReady("CEILING_NOT_READY");
    const ids=new Set(p.principalVersionIds);
    if (ids.size!==p.principalVersionIds.length) return notReady("GRANT_MISMATCH");
    const selected=ceilings.principal.filter(item=>ids.has(item.versionId));
    if (selected.length!==ids.size) return notReady("CEILING_NOT_READY");
    const exact=new Set(projected.grants.map(grantCanonicalJson));
    const organizationIds=new Set(ceilings.organization.map(item=>item.versionId));
    const policies=new PolicyRepository(tx,this.context);policies.authorize();
    const result:Selected[]=selected.map(item=>{
      const grant=item.grant;
      if (!item.parentOrganizationVersionId || !organizationIds.has(item.parentOrganizationVersionId))
        return notReady("CEILING_NOT_READY");
      if (!exact.has(grantCanonicalJson(grant))) return notReady("GRANT_MISMATCH");
      if (grant.connection?.kind!=="local_connector" || grant.connection.id!==grant.tool.source
        || grant.execution_target!==null || grant.approval!==null
        || grant.resource_scope.kind!=="workspace_path" || grant.constraints.effects.length!==1
        || grant.constraints.effects[0]!=="read" || grant.resource_scope.resource.includes("*"))
        return notReady("GRANT_MISMATCH");
      const sourceRepo=new SourceRepository(tx,this.context);sourceRepo.authorize();
      const active=sourceRepo.active(grant.tool.source);
      if (!active) return notReady("SOURCE_NOT_READY");
      const release=sourceRepo.release(active.releaseId);
      const tool=release.tools.find(t=>t.key===grant.tool.key && t.contractId===grant.contract.id
        && t.contractHash===grant.contract.hash && t.schemaHash===grant.constraints.argument_schema_hash);
      if (!tool) return notReady("TOOL_CONTRACT_NOT_READY");
      const grantPolicy=policies.get(grant.policy.id),grantSelection=policies.latest(grantPolicy.bindingId);
      if (grantPolicy.releaseHash!==grant.policy.hash || !grantSelection
        || grantSelection.action==="deactivate" || grantSelection.releaseId!==grantPolicy.id
        || (grantPolicy.target.layer!=="organization" && (grantPolicy.target.layer!=="agent"
          || grantPolicy.target.agentId!==agent.id || grantPolicy.target.versionId!==p.agentVersionId)))
        return notReady("POLICY_NOT_READY");
      const leafBinding=policies.binding({layer:"agent",agentId:agent.id,versionId:p.agentVersionId},
        publishedSourcePolicyName(grant.tool.source,grant.tool.key));
      if (!leafBinding) return notReady("POLICY_NOT_READY");
      const leafSelection=policies.latest(String(leafBinding.id));
      if (!leafSelection || leafSelection.action==="deactivate") return notReady("POLICY_NOT_READY");
      const policy=policies.get(leafSelection.releaseId);
      return {versionId:item.versionId,parentId:item.parentOrganizationVersionId,grant,
        grantPolicyId:grantPolicy.id,grantPolicyHash:grantPolicy.releaseHash,
        connectorRevision:release.pin.connectorRevision,
        connectorConfigHash:release.pin.configHash,credentialRevision:release.pin.credentialRevision,
        policyPin:{id:policy.id,releaseHash:policy.releaseHash,stateRevision:policy.stateRevision,
          selectionSequence:leafSelection.sequence},
        sourcePin:{sourceId:release.sourceId,releaseId:release.id,contractId:tool.contractId,
          contractHash:tool.contractHash,schemaHash:tool.schemaHash}};
    });
    result.sort((a,b)=>{
      const x=Buffer.from(grantCanonicalJson(a.grant)),y=Buffer.from(grantCanonicalJson(b.grant));
      return Buffer.compare(x,y);
    });
    const workspace=tx.get(`SELECT path,identity_json FROM local_session_tree_projects WHERE org_id=? AND project_id=?
      AND principal_type=? AND principal_id=?`,this.context.org_id,this.context.project_id,
    this.context.principal.type,this.context.principal.id);
    if (!workspace) return notReady("WORKSPACE_NOT_READY");
    const workspaceHash=grantDigest(LocalFolderIdentitySchema.parse(JSON.parse(String(workspace.identity_json))));
    return {assignmentId:p.assignmentId,agentVersionId:p.agentVersionId,agentPrincipalId:agent.id,
      targetProjectId:this.context.project_id,sourceProjectId:agent.home_project_id,workspaceHash,
      workspacePath:String(workspace.path),
      organizationRevision:ceilings.organizationRevision,principalRevision:ceilings.principalRevision,
      organizationHash:ceilings.organizationHash,principalHash:ceilings.principalHash,
      agentVersionHash:grantSetDigest(normalizeToolGrants(projected)),selected:result};
  }
  async prepare(raw:unknown):Promise<{check:(tx:SqliteUnit)=>DirectGrantReadyProof}> {
    const p=RequestSchema.parse(raw);
    const initial=this.store.transaction(tx=>this.snapshot(tx,p));
    let root;
    try { root=await snapshotProjectRoot(initial.workspacePath); }
    catch { return notReady("WORKSPACE_NOT_READY"); }
    if (grantDigest({kind:"local_folder",canonical_path:root.canonicalPath,dev:root.dev,ino:root.ino})
      !==initial.workspaceHash) return notReady("WORKSPACE_NOT_READY");
    const services=initial.selected.map(item=>{
      if (!this.store.transaction(tx=>!!tx.get(`SELECT 1 FROM resource_fences WHERE org_id=? AND project_id=?
        AND resource_key=?`,this.context.org_id,this.context.project_id,POLICY_FENCE)))
        return notReady("POLICY_NOT_READY");
      const binding=publishedSourcePolicyService(this.store,this.context,this.source,this.registry,
        item.grant.tool.source,item.grant.tool.key);
      binding.policy.preparePublishedSource();
      return binding.policy;
    });
    let used=false;
    return {check:(tx:SqliteUnit)=>{
      if (used) return notReady("SOURCE_NOT_READY");
      used=true;
      const live=this.snapshot(tx,p);
      if (grantCanonicalJson(live)!==grantCanonicalJson(initial)) return notReady("CEILING_NOT_READY");
      const selected=live.selected.map((item,index)=>{
        const policy=services[index].revalidatePublishedSource(tx,
          {layer:"agent",agentId:live.agentPrincipalId,versionId:live.agentVersionId},
          item.policyPin,[{type:"workspace_path",value:item.grant.resource_scope.resource,mode:"read"}],item.sourcePin);
        if (!policy.source) return notReady("SOURCE_NOT_READY");
        if (item.grantPolicyId!==policy.policy.id && !policy.ancestors.some(a=>
          a.id===item.grantPolicyId && a.releaseHash===item.grantPolicyHash))
          return notReady("POLICY_NOT_READY");
        if (policy.decision.outcome==="deny") return notReady("POLICY_DENIED");
        if (policy.decision.outcome==="require_approval") return notReady("POLICY_APPROVAL_REQUIRED");
        return {principalVersionId:item.versionId,parentOrganizationVersionId:item.parentId,
          tupleHash:grantDigest(item.grant),sourceId:policy.source.sourceId,
          sourceReleaseId:policy.source.sourceReleaseId,sourceActivationRevision:policy.source.sourceActivationRevision,
          contractId:policy.source.contractId,contractHash:policy.source.contractHash,
          schemaHash:policy.source.schemaHash,connectionId:policy.source.connectionId,
          connectionAuthorityHash:item.grant.connection!.authority_hash,
          connectorRevision:item.connectorRevision,connectorConfigHash:item.connectorConfigHash,
          credentialRevision:item.credentialRevision,
          policyId:policy.policy.id,policyHash:policy.policy.releaseHash,
          policyStateRevision:policy.policy.stateRevision,policySelectionSequence:policy.policy.selectionSequence,
          ancestorPolicies:policy.ancestors.map(a=>({id:a.id,releaseHash:a.releaseHash,
            stateRevision:a.stateRevision,selectionSequence:a.selectionSequence}))};
      });
      let currentRoot;
      try { currentRoot=snapshotProjectRootSync(live.workspacePath); }
      catch { return notReady("WORKSPACE_NOT_READY"); }
      if (grantDigest({kind:"local_folder",canonical_path:currentRoot.canonicalPath,
        dev:currentRoot.dev,ino:currentRoot.ino})!==live.workspaceHash)
        return notReady("WORKSPACE_NOT_READY");
      return {state:"ready",assignmentId:p.assignmentId,agentVersionId:p.agentVersionId,
        agentPrincipalId:live.agentPrincipalId,targetProjectId:live.targetProjectId,
        sourceProjectId:live.sourceProjectId,workspaceHash:live.workspaceHash,
        organizationRevision:live.organizationRevision,principalRevision:live.principalRevision,
        organizationCeilingHash:live.organizationHash,principalGrantHash:live.principalHash,
        agentVersionGrantHash:live.agentVersionHash,selected,executionReady:false,grantsAuthority:false};
    }};
  }
  async readiness(raw:unknown):Promise<DirectGrantReadiness> {
    try { const prepared=await this.prepare(raw);return this.store.transaction(tx=>prepared.check(tx)); }
    catch(error) {return {state:"not_ready",reason:reason(error),executionReady:false,grantsAuthority:false};}
  }
}
