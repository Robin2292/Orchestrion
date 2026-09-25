import { z } from "zod";
import { LocalToolAnchorSchema, LocalIdSchema, LocalHashSchema, LocalRevisionSchema } from "../local-contracts";
import { ToolScopeSchema } from "../tool-scope";
import { P0EvaluationSchema } from "./p0-evaluator";

export const PolicyTargetSchema = z.discriminatedUnion("layer", [
  z.object({ layer: z.literal("organization") }).strict(),
  z.object({ layer: z.literal("workflow"), workflowId: LocalIdSchema }).strict(),
  z.object({ layer: z.literal("agent"), agentId: LocalIdSchema, versionId: LocalIdSchema }).strict(),
  z.object({ layer: z.literal("node"), workflowId: LocalIdSchema, nodeId: LocalIdSchema }).strict(),
]);
export type PolicyTarget = z.infer<typeof PolicyTargetSchema>;
export const PolicyDefinitionSchema = P0EvaluationSchema.innerType().shape.policies.element;
export type PolicyDefinition = z.infer<typeof PolicyDefinitionSchema>;
export const PolicyDraftSchema = z.object({ target: PolicyTargetSchema, toolName: LocalIdSchema,
  definition: PolicyDefinitionSchema }).strict();
export const PolicyIdSchema = z.object({ id: LocalIdSchema }).strict();
export const PolicyPinSchema = PolicyIdSchema.extend({ releaseHash: LocalHashSchema,
  stateRevision: LocalRevisionSchema }).strict();
export const PolicyTransitionSchema = PolicyPinSchema.extend({ action: z.enum(["review", "publish", "revoke"]) }).strict();
export const PolicySelectionSchema = PolicyPinSchema.extend({ action: z.enum(["activate", "rollback", "deactivate"]),
  expectedSequence: LocalRevisionSchema }).strict();
export const PolicyPreviewSchema = PolicyPinSchema.extend({
  claims: P0EvaluationSchema.innerType().shape.claims,
}).strict();
export const PolicyActiveSummaryInputSchema = z.object({
  target: PolicyTargetSchema,
  toolName: LocalIdSchema,
  connectorId: LocalIdSchema,
  connectionId: LocalIdSchema,
  toolAnchor: LocalToolAnchorSchema,
}).strict();
export const PolicyActiveSummarySchema = z.object({
  approvalRequired: z.boolean(),
  effectiveScope: ToolScopeSchema,
}).strict();
export type PolicyActiveSummary = z.infer<typeof PolicyActiveSummarySchema>;
export const PolicyReleaseSchema = z.object({ schemaVersion: z.literal("orchestrion.local.policy.v2"),
  id: LocalIdSchema, bindingId: LocalIdSchema, revision: LocalRevisionSchema.refine((v) => v > 0),
  target: PolicyTargetSchema, toolName: LocalIdSchema, definition: PolicyDefinitionSchema,
  scope: ToolScopeSchema, toolAnchor: LocalToolAnchorSchema, releaseHash: LocalHashSchema, createdAt: z.string().datetime(),
  lifecycle: z.enum(["draft", "reviewed", "published", "revoked"]), stateRevision: LocalRevisionSchema,
}).strict();
export type PolicyRelease = z.infer<typeof PolicyReleaseSchema>;
export const PolicyRejectionCodeSchema = z.enum(["POLICY_NOT_FOUND", "POLICY_STATE_CONFLICT", "POLICY_HASH_CONFLICT",
  "POLICY_AUTHORITY_UNAVAILABLE", "POLICY_RELEASE_STALE", "POLICY_ROLLBACK_INVALID", "POLICY_INACTIVE",
  "POLICY_REVOKED", "POLICY_BINDING_CONFLICT", "TOOL_SCHEMA_DRIFT", "TOOL_SCHEMA_INVALID",
  "TOOL_IMPLEMENTATION_MISSING", "TOOL_IMPLEMENTATION_UNAVAILABLE", "AUTHORITY_SCOPE_WIDENING", "AUTHORITY_SCOPE_INVALID"]);
export function serializePolicyRelease(value: PolicyRelease): string { return JSON.stringify(PolicyReleaseSchema.parse(value)); }
export function loadPolicyRelease(value: string): PolicyRelease { return PolicyReleaseSchema.parse(JSON.parse(value)); }
