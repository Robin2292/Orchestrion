import { z } from "zod";
import { LocalErrorCodeSchema, LocalIdSchema, LocalVersionPinSchema } from "./local-contracts";

export const LOCAL_DIRECT_SESSION_CHANNEL="orchestrion:local-direct-session" as const;
const identity={requestId:z.string().uuid(),idempotencyKey:z.string().uuid(),expected:LocalVersionPinSchema};
const session=z.object({sessionId:LocalIdSchema}).strict();
export const LocalDirectSessionRequestSchema=z.discriminatedUnion("operation",[
  z.object({operation:z.literal("list"),limit:z.number().int().min(1).max(100),offset:z.number().int().nonnegative().safe()}).strict(),
  z.object({operation:z.literal("get"),sessionId:LocalIdSchema}).strict(),
  z.object({operation:z.literal("create"),...identity,payload:z.object({assignmentId:LocalIdSchema,
    assignmentVersionId:LocalIdSchema,title:z.string().trim().min(1).max(255)}).strict()}).strict(),
  z.object({operation:z.literal("rename"),...identity,payload:session.extend({title:z.string().trim().min(1).max(255)})}).strict(),
  z.object({operation:z.literal("archive"),...identity,payload:session}).strict(),
  z.object({operation:z.literal("restore"),...identity,payload:session}).strict(),
  z.object({operation:z.literal("delete"),...identity,payload:session}).strict(),
]);
export type LocalDirectSessionRequest=z.infer<typeof LocalDirectSessionRequestSchema>;
export const LocalDirectSessionItemSchema=z.object({
  id:LocalIdSchema,projectId:LocalIdSchema,agentId:LocalIdSchema,
  agentVersionId:LocalIdSchema,assignmentId:LocalIdSchema,
  assignmentVersionId:LocalIdSchema,lifecycle:z.enum(["active","archived"]),
  title:z.string(),createdAt:z.string().datetime(),
  latestAttempt:z.object({number:z.number().int().positive(),outcome:z.enum([
    "running","waiting","completed","failed","cancelled",
  ])}).strict().nullable(),provenance:z.literal("released"),
}).strict();
export type LocalDirectSessionItem=z.infer<typeof LocalDirectSessionItemSchema>;
export const LocalDirectSessionValueSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("page"),expected:LocalVersionPinSchema,
    items:z.array(LocalDirectSessionItemSchema).max(100)}).strict(),
  z.object({kind:z.literal("detail"),expected:LocalVersionPinSchema,session:z.object({
    id:LocalIdSchema,projectId:LocalIdSchema,agentId:LocalIdSchema,
    agentVersionId:LocalIdSchema,assignmentId:LocalIdSchema,
    assignmentVersionId:LocalIdSchema,lifecycle:z.enum(["active","archived"]),createdAt:z.string().datetime(),
    title:z.string(),deleted:z.boolean(),deleting:z.boolean(),provenance:z.literal("released"),
    latestAttempt:LocalDirectSessionItemSchema.shape.latestAttempt,
  }).strict().nullable()}).strict(),
  z.object({kind:z.literal("command"),expected:LocalVersionPinSchema,
    resultRef:LocalIdSchema,replayed:z.boolean()}).strict(),
]);
export type LocalDirectSessionValue=z.infer<typeof LocalDirectSessionValueSchema>;
export const LocalDirectSessionErrorCodeSchema=z.union([LocalErrorCodeSchema,z.enum([
  "DIRECT_SESSION_UNAVAILABLE","DIRECT_SESSION_INACTIVE","DIRECT_SESSION_STATE_CONFLICT",
  "DIRECT_ASSIGNMENT_UNAVAILABLE","DIRECT_PRINCIPAL_UNAVAILABLE","DIRECT_VERSION_UNAVAILABLE",
  "DIRECT_VERSION_CHANGED","DIRECT_AUTHORITY_UNAVAILABLE","DIRECT_BUDGET_REVOKED",
  "DIRECT_PROVIDER_UNAVAILABLE","DIRECT_ATTEMPT_STATE_CONFLICT","DIRECT_PIN_REVOKED",
])]);
export const LocalDirectSessionReplySchema=z.union([
  z.object({ok:z.literal(true),value:LocalDirectSessionValueSchema}).strict(),
  z.object({ok:z.literal(false),error:z.object({code:LocalDirectSessionErrorCodeSchema,
    retryable:z.literal(false)}).strict()}).strict(),
]);
export type LocalDirectSessionReply=z.infer<typeof LocalDirectSessionReplySchema>;
export function loadLocalDirectSessionReply(value:unknown):LocalDirectSessionReply {
  return LocalDirectSessionReplySchema.parse(value);
}
