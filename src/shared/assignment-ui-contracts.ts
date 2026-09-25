import { z } from "zod";
import { AgentSoulSnapshotSchema } from "./agent-soul-contracts";
import { AgentCreateSchema, AgentDefinitionSchema } from "./agent-contracts";
import { AgentIdentitySchema, ProjectAgentAssignmentSchema,
  ProjectAgentAssignmentVersionSchema } from "./agent-session-contracts";
import { LocalErrorCodeSchema, LocalIdSchema, LocalVersionPinSchema } from "./local-contracts";
import { ToolGrantSchema } from "./tool-grant-contracts";

export const LOCAL_ASSIGNMENT_UI_CHANNEL = "orchestrion:local-assignment-ui" as const;
const identity = { requestId:z.string().uuid(), idempotencyKey:z.string().uuid(), expected:LocalVersionPinSchema };
const id = z.object({ id:LocalIdSchema }).strict();
const agentId = z.object({ agentId:LocalIdSchema }).strict();
const create = AgentCreateSchema.extend({
  visibility:z.enum(["organization","project"]), sourceVersionId:LocalIdSchema.nullable(),
}).strict();
const configuration = ProjectAgentAssignmentVersionSchema.omit({
  schemaVersion:true,id:true,orgId:true,assignmentId:true,revision:true,agentVersionId:true,
  resolvedConfigHash:true,authorityCeilingHash:true,memoryScopeHash:true,createdAt:true,createdByPrincipalId:true,
}).strict();
const versionChange=z.object({assignmentId:LocalIdSchema,agentVersionId:LocalIdSchema,config:configuration}).strict();

/** No org, Project, principal, budget proof or runtime owner is accepted from a renderer. */
export const LocalAssignmentUiRequestSchema = z.discriminatedUnion("operation", [
  z.object({operation:z.literal("list"),limit:z.number().int().min(1).max(100),offset:z.number().int().nonnegative().safe()}).strict(),
  z.object({operation:z.literal("detail"),assignmentId:LocalIdSchema}).strict(),
  z.object({operation:z.literal("catalog.list"),limit:z.number().int().min(1).max(100),offset:z.number().int().nonnegative().safe()}).strict(),
  z.object({operation:z.literal("catalog.detail"),agentId:LocalIdSchema,limit:z.number().int().min(1).max(100),offset:z.number().int().nonnegative().safe()}).strict(),
  z.object({operation:z.literal("grant.preview"),assignmentId:LocalIdSchema,
    agentVersionId:LocalIdSchema,principalVersionIds:z.array(LocalIdSchema).max(32)}).strict(),
  z.object({operation:z.literal("create"),...identity,payload:create}).strict(),
  z.object({operation:z.literal("adopt"),...identity,payload:agentId}).strict(),
  z.object({operation:z.literal("add"),...identity,payload:agentId}).strict(),
  z.object({operation:z.literal("promote"),...identity,payload:agentId}).strict(),
  z.object({operation:z.literal("configure"),...identity,payload:versionChange}).strict(),
  // Updating to another exact AgentVersion creates the next immutable
  // AssignmentVersion through the same reviewed configuration path.
  z.object({operation:z.literal("update"),...identity,payload:versionChange}).strict(),
  z.object({operation:z.literal("disable"),...identity,payload:id}).strict(),
  z.object({operation:z.literal("enable"),...identity,payload:id}).strict(),
  z.object({operation:z.literal("remove"),...identity,payload:id}).strict(),
]);
export type LocalAssignmentUiRequest = z.infer<typeof LocalAssignmentUiRequestSchema>;

const AgentProjectionSchema = z.discriminatedUnion("identityState", [
  z.object({identityState:z.literal("governed"),identity:AgentIdentitySchema}).strict(),
  z.object({identityState:z.literal("legacy_unresolved"),id:LocalIdSchema,
    name:z.string().min(1).max(255),homeProjectId:LocalIdSchema}).strict(),
]);
export const LocalAssignmentItemSchema = z.object({
  assignment:ProjectAgentAssignmentSchema,
  agent:AgentProjectionSchema,
  migrationState:z.enum(["governed","legacy_unversioned"]),
  currentVersion:ProjectAgentAssignmentVersionSchema.nullable(),
}).strict();
export type LocalAssignmentItem = z.infer<typeof LocalAssignmentItemSchema>;
export const CatalogAgentVersionSchema = z.object({
  id:LocalIdSchema,versionNumber:z.number().int().positive().safe(),
  definition:AgentDefinitionSchema,soul:AgentSoulSnapshotSchema.optional(),
  createdAt:z.string().datetime({offset:true}),
}).strict();
export const CatalogAgentItemSchema = z.object({
  identity:AgentIdentitySchema,
  latestVersionId:LocalIdSchema,
  latestVersionNumber:z.number().int().positive().safe(),
  assignmentStatus:z.enum(["active","disabled","removed"]).nullable(),
  eligibleForAdd:z.boolean(),
}).strict();
export type CatalogAgentItem = z.infer<typeof CatalogAgentItemSchema>;
export const LocalAssignmentUiValueSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("page"),expected:LocalVersionPinSchema,items:z.array(LocalAssignmentItemSchema).max(100)}).strict(),
  z.object({kind:z.literal("detail"),expected:LocalVersionPinSchema,item:LocalAssignmentItemSchema.nullable()}).strict(),
  z.object({kind:z.literal("catalog.page"),expected:LocalVersionPinSchema,
    items:z.array(CatalogAgentItemSchema).max(100),total:z.number().int().nonnegative().safe()}).strict(),
  z.object({kind:z.literal("catalog.detail"),expected:LocalVersionPinSchema,
    item:CatalogAgentItemSchema,versions:z.array(CatalogAgentVersionSchema).max(100),
    totalVersions:z.number().int().nonnegative().safe()}).strict(),
  z.object({kind:z.literal("grant.preview"),assignmentId:LocalIdSchema,agentVersionId:LocalIdSchema,
    options:z.array(z.object({principalVersionId:LocalIdSchema,grant:ToolGrantSchema}).strict()).max(512),
    readiness:z.discriminatedUnion("state",[
      z.object({state:z.literal("empty"),executionReady:z.literal(false)}).strict(),
      z.object({state:z.literal("ready"),executionReady:z.literal(false)}).strict(),
      z.object({state:z.literal("not_ready"),reason:z.enum(["ASSIGNMENT_NOT_READY","AGENT_VERSION_NOT_READY",
        "CEILING_NOT_READY","GRANT_MISMATCH","TOOL_CONTRACT_NOT_READY","SOURCE_NOT_READY",
        "POLICY_NOT_READY","POLICY_DENIED","POLICY_APPROVAL_REQUIRED","WORKSPACE_NOT_READY"]),
        executionReady:z.literal(false)}).strict(),
    ])}).strict(),
  z.object({kind:z.literal("command"),expected:LocalVersionPinSchema,resultRef:LocalIdSchema,replayed:z.boolean()}).strict(),
]);
export type LocalAssignmentUiValue = z.infer<typeof LocalAssignmentUiValueSchema>;
export const AssignmentUiErrorCodeSchema = z.union([LocalErrorCodeSchema,z.enum([
  "ASSIGNMENT_NOT_READY","ASSIGNMENT_DENIED","ASSIGNMENT_NOT_FOUND","ASSIGNMENT_NOT_ACTIVE",
  "ASSIGNMENT_ALREADY_EXISTS","ASSIGNMENT_STATE_CONFLICT","AGENT_NOT_FOUND",
  "AGENT_VERSION_NOT_FOUND","ASSIGNMENT_PLACEMENT_DENIED","AGENT_VARIANT_SOURCE_SCOPE_DENIED",
  "AGENT_CATALOG_NOT_FOUND","AGENT_CATALOG_NOT_READY",
])]);
export type AssignmentUiErrorCode = z.infer<typeof AssignmentUiErrorCodeSchema>;
export const LocalAssignmentUiReplySchema = z.union([
  z.object({ok:z.literal(true),value:LocalAssignmentUiValueSchema}).strict(),
  z.object({ok:z.literal(false),error:z.object({code:AssignmentUiErrorCodeSchema,retryable:z.literal(false)}).strict()}).strict(),
]);
export type LocalAssignmentUiReply = z.infer<typeof LocalAssignmentUiReplySchema>;
export function loadLocalAssignmentUiReply(value: unknown): LocalAssignmentUiReply {
  return LocalAssignmentUiReplySchema.parse(value);
}
