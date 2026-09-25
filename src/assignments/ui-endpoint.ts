import { ZodError } from "zod";
import { LocalProjectAssignmentService } from "./service";
import { LocalAgentCatalogService } from "./catalog-service";
import type { CatalogRow } from "./repository";
import { StorageError } from "../storage/sqlite/foundation";
import { LOCAL_CONTRACT_VERSION } from "../shared/local-contracts";
import { verifyAgentSoul } from "../agents/soul-document";
import { AGENT_SESSION_CONTRACT_VERSION } from "../shared/agent-session-contracts";
import { AssignmentUiErrorCodeSchema, CatalogAgentItemSchema, CatalogAgentVersionSchema,
  LocalAssignmentItemSchema, LocalAssignmentUiRequestSchema,
  LocalAssignmentUiValueSchema, type AssignmentUiErrorCode, type LocalAssignmentUiReply } from "../shared/assignment-ui-contracts";

type AssignmentDetail = NonNullable<ReturnType<LocalProjectAssignmentService["detail"]>>;
function project(value: AssignmentDetail) {
  const {assignment,agent,currentVersion}=value;
  const agentProjection=agent.identity_state==="governed" ? {
    identityState:"governed",identity:{ schemaVersion:AGENT_SESSION_CONTRACT_VERSION,
      id:agent.id,orgId:agent.org_id,name:agent.name,visibility:agent.visibility,
      homeProjectId:agent.home_project_id,derivedFromAgentVersionId:agent.derived_from_agent_version_id,
      agentPrincipal:{type:"agent",id:agent.agent_principal_id},
    },
  } : {identityState:"legacy_unresolved",id:agent.id,name:agent.name,homeProjectId:agent.home_project_id};
  return LocalAssignmentItemSchema.parse({
    assignment:{schemaVersion:AGENT_SESSION_CONTRACT_VERSION,id:assignment.id,orgId:assignment.org_id,
      projectId:assignment.project_id,agentId:assignment.agent_id,
      currentAssignmentVersionId:assignment.current_assignment_version_id,status:assignment.status},
    agent:agentProjection,migrationState:assignment.migration_state,currentVersion,
  });
}
function catalogItem(row: CatalogRow, canAdd: boolean) {
  return CatalogAgentItemSchema.parse({
    identity:{schemaVersion:AGENT_SESSION_CONTRACT_VERSION,id:row.id,orgId:row.org_id,
      name:row.name,visibility:row.visibility,homeProjectId:row.home_project_id,
      derivedFromAgentVersionId:row.derived_from_agent_version_id,
      agentPrincipal:{type:"agent",id:row.agent_principal_id}},
    latestVersionId:row.latest_version_id,latestVersionNumber:row.latest_version_number,
    assignmentStatus:row.assignment_status,eligibleForAdd:canAdd && row.assignment_status===null,
  });
}
function failure(code: AssignmentUiErrorCode): LocalAssignmentUiReply {
  return {ok:false,error:{code,retryable:false}};
}
function typedError(error: unknown, invoked: boolean): LocalAssignmentUiReply {
  if (error instanceof ZodError) return failure("INVALID_PAYLOAD");
  if (error instanceof StorageError) {
    if (error.code==="CONTEXT_MISMATCH") return failure("NOT_AUTHENTICATED");
    if (["ASSIGNMENT_BUDGET_AUTHORITY_REQUIRED","ASSIGNMENT_AUTHORITY_UNRESOLVED"].includes(error.code))
      return failure("ASSIGNMENT_NOT_READY");
    if (["ASSIGNMENT_MEMORY_SCOPE_DENIED",
      "ASSIGNMENT_BUDGET_CEILING_INVALID","ASSIGNMENT_BUDGET_CEILING_EXCEEDED"].includes(error.code))
      return failure("ASSIGNMENT_DENIED");
    const code=AssignmentUiErrorCodeSchema.safeParse(error.code);
    if (code.success) return failure(code.data);
  }
  return failure(invoked ? "OUTCOME_UNKNOWN" : "SERVICE_UNAVAILABLE");
}

/** Authenticated utility-host adapter. The renderer supplies only command data and
 * the expected CAS pin; context, owner and principal come from the live service. */
export class LocalAssignmentUiEndpoint {
  constructor(private readonly resolve: () => LocalProjectAssignmentService | null,
    private readonly resolveCatalog: () => LocalAgentCatalogService | null = () => null) {}

  async invoke(raw: unknown, isActive: () => boolean): Promise<LocalAssignmentUiReply> {
    const parsed=LocalAssignmentUiRequestSchema.safeParse(raw);
    if (!parsed.success) return failure("INVALID_PAYLOAD");
    if (!isActive()) return failure("NOT_AUTHENTICATED");
    let invoked=false;
    try {
      const request=parsed.data;
      if (request.operation==="catalog.list" || request.operation==="catalog.detail") {
        const catalog=this.resolveCatalog();
        if (!catalog) return failure("SERVICE_UNAVAILABLE");
        if (request.operation==="catalog.list") {
          const page=catalog.list(request.limit,request.offset);
          if (!isActive()) return failure("NOT_AUTHENTICATED");
          return {ok:true,value:LocalAssignmentUiValueSchema.parse({kind:"catalog.page",
            expected:page.expected,total:page.total,
            items:page.items.map(row=>catalogItem(row,page.canAdd))})};
        }
        const detail=catalog.detail(request.agentId,request.limit,request.offset);
        if (!isActive()) return failure("NOT_AUTHENTICATED");
        return {ok:true,value:LocalAssignmentUiValueSchema.parse({kind:"catalog.detail",
          expected:detail.expected,
          item:catalogItem(detail.item,detail.canAdd),totalVersions:detail.totalVersions,
          versions:detail.versions.map(v=>{
            const definition=JSON.parse(v.definition_json);
            return CatalogAgentVersionSchema.parse({
              id:v.id,versionNumber:v.version_number,definition,createdAt:v.created_at,
              ...(v.soul_content === null ? {} : { soul:verifyAgentSoul({content:v.soul_content,hash:v.soul_hash!},
                definition.systemPrompt ?? null) }),
            });
          })})};
      }
      const service=this.resolve();
      if (!service) return failure("SERVICE_UNAVAILABLE");
      if (request.operation==="list") return {ok:true,value:LocalAssignmentUiValueSchema.parse({
        kind:"page",expected:service.authority().expected,
        items:service.list(request.limit,request.offset).map(project),
      })};
      if (request.operation==="detail") return {ok:true,value:LocalAssignmentUiValueSchema.parse({
        kind:"detail",expected:service.authority().expected,
        item:(() => { const row=service.detail(request.assignmentId); return row ? project(row) : null; })(),
      })};
      if (request.operation==="grant.preview") {
        const preview=await service.grantPreview(request.assignmentId,request.agentVersionId,
          request.principalVersionIds);
        if (!isActive()) return failure("NOT_AUTHENTICATED");
        return {ok:true,value:LocalAssignmentUiValueSchema.parse({kind:"grant.preview",
          assignmentId:request.assignmentId,agentVersionId:request.agentVersionId,...preview})};
      }
      const header={...service.authority(),expected:request.expected,schema_version:LOCAL_CONTRACT_VERSION,
        request_id:request.requestId,idempotency_key:request.idempotencyKey};
      if (!isActive()) return failure("NOT_AUTHENTICATED");
      invoked=true;
      const result=request.operation==="create" ? service.createAgent(header,request.payload)
        : request.operation==="adopt" ? service.adoptExisting(header,request.payload.agentId)
        : request.operation==="add" ? service.add(header,request.payload.agentId)
        : request.operation==="promote" ? service.promote(header,request.payload.agentId)
        : request.operation==="disable" ? service.disable(header,request.payload.id)
        : request.operation==="enable" ? service.enable(header,request.payload.id)
        : request.operation==="remove" ? service.remove(header,request.payload.id)
        : await service.configure(header,request.payload.assignmentId,request.payload.agentVersionId,
          request.payload.config,() => { if (!isActive()) throw new StorageError("NOT_AUTHENTICATED"); });
      return {ok:true,value:LocalAssignmentUiValueSchema.parse({kind:"command",
        expected:service.authority().expected,resultRef:result.resultRef,replayed:result.replayed})};
    } catch (error) { return typedError(error,invoked); }
  }
}
