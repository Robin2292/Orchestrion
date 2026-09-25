import { z } from "zod";
import { LocalContextSchema, LocalIdSchema, LocalHashSchema, LocalRevisionSchema, LocalRunIdentitySchema,
  LocalToolAnchorSchema, RuntimeOwnerSchema, LocalVersionPinSchema } from "./local-contracts";
import { CredentialRequestSchema } from "./credential-contracts";
import { PolicyPinSchema, PolicyTargetSchema } from "./policy/p1-contracts";
import { P0EvaluationSchema } from "./policy/p0-evaluator";
import { ToolScopeSchema } from "./tool-scope";
import { ExecutionPlacementBindingSchema, ExecutionPlacementKindSchema } from "./execution-placement-contracts";

export const InvocationPolicyPinSchema = PolicyPinSchema.extend({ selectionSequence: LocalRevisionSchema }).strict();
/** Intent and expected pins only. No caller-supplied target, policy, planner,
 * schema, safety traits, scope, credential or placement can become authority. */
export const ToolInvocationRequestSchema = z.object({
  connectorId: LocalIdSchema, connectionId: LocalIdSchema, anchor: LocalToolAnchorSchema,
  policy: InvocationPolicyPinSchema, arguments: z.record(z.unknown()),
}).strict();
export type ToolInvocationRequest = z.infer<typeof ToolInvocationRequestSchema>;

/** Code-reviewed composition metadata, never Tool.describe/model metadata. */
export const ToolPlanningReviewSchema = z.object({
  version: LocalIdSchema, effect: z.enum(["read_only", "protected"]),
  resourceKind: z.enum(["logical_workspace_path", "filesystem", "http_endpoint"]),
}).strict();
export type ToolPlanningReview = z.infer<typeof ToolPlanningReviewSchema>;
export const ToolPlannerOutputSchema = z.object({ arguments: z.record(z.unknown()),
  claims: P0EvaluationSchema.innerType().shape.claims }).strict();
export type ToolPlannerInput = { arguments: Record<string, unknown>; scope: z.infer<typeof ToolScopeSchema> };

export const InvocationConnectionSchema = z.object({
  connectorId: LocalIdSchema, connectionId: LocalIdSchema, revision: LocalRevisionSchema,
  status: z.enum(["active", "inactive", "deleted"]), credential: CredentialRequestSchema.nullable(),
}).strict();
/** Host-only proof read from live target/connection owners. Null proof denies.
 * C0 owns Connector storage; this contract does not create or manage connections. */
const LegacyInvocationPlacementProofSchema = z.object({
  kind: z.enum(["local_logical", "local_filesystem", "runner"]),
  owner: RuntimeOwnerSchema,
}).strict();
const CanonicalInvocationPlacementProofSchema = z.object({
  kind: ExecutionPlacementKindSchema,
  owner: RuntimeOwnerSchema,
  binding: ExecutionPlacementBindingSchema,
}).strict().refine((value) => value.kind === value.binding.placement, {
  path: ["binding", "placement"],
  message: "placement proof does not match its task binding",
});
export const InvocationPlacementProofSchema = z.union([
  LegacyInvocationPlacementProofSchema,
  CanonicalInvocationPlacementProofSchema,
]);

export const InvocationHostProofSchema = z.object({
  context: LocalContextSchema, target: PolicyTargetSchema, targetPin: LocalVersionPinSchema,
  run: LocalRunIdentitySchema.nullable(), lifecycle: z.enum(["active", "inactive", "deleted"]),
  connection: InvocationConnectionSchema,
  placement: InvocationPlacementProofSchema,
}).strict().refine((value) => !("binding" in value.placement)
  || value.placement.binding.project_id === value.context.project_id, {
  path: ["placement", "binding", "project_id"],
  message: "placement binding does not match host project",
});
export type InvocationHostProof = z.infer<typeof InvocationHostProofSchema>;

export const InvocationPolicyEvidenceSchema = InvocationPolicyPinSchema.extend({ target: PolicyTargetSchema,
  anchor: LocalToolAnchorSchema }).strict();
const DirectGrantLimitsSchema = z.object({
  maxOutputBytes: z.number().int().positive().safe(),
  maxRuntimeSeconds: z.number().int().positive().safe(),
}).strict();
export const ToolInvocationPlanSchema = z.object({
  schemaVersion: z.literal("orchestrion.local.tool-plan.v2"), authority: z.literal("direct_tool_grants@1"),
  context: LocalContextSchema, target: PolicyTargetSchema, targetPin: LocalVersionPinSchema,
  run: LocalRunIdentitySchema.nullable(), connection: InvocationConnectionSchema,
  placement: InvocationPlacementProofSchema, anchor: LocalToolAnchorSchema,
  review: ToolPlanningReviewSchema,
  policies: z.array(InvocationPolicyEvidenceSchema).min(1).max(4),
  arguments: z.record(z.unknown()), claims: ToolPlannerOutputSchema.shape.claims, scope: ToolScopeSchema,
  directGrantHash: LocalHashSchema.optional(), directGrantLimits: DirectGrantLimitsSchema.optional(), hash: LocalHashSchema,
  sourceRuntimePin: z.object({ releaseId:LocalIdSchema,activationRevision:LocalRevisionSchema }).strict().optional(),
}).strict().refine((value) => value.directGrantHash !== undefined && value.directGrantLimits !== undefined,
  { message: "DIRECT_GRANT_IDENTITY_REQUIRED" });
export type ToolInvocationPlan = z.infer<typeof ToolInvocationPlanSchema>;
export const ToolInvocationRejectionCodeSchema = z.enum([
  "TOOL_INVOCATION_AUTHORITY_UNAVAILABLE", "TOOL_TARGET_NOT_READY", "TOOL_CONNECTION_NOT_READY",
  "TOOL_PLACEMENT_NOT_READY", "TOOL_RESOURCE_NOT_READY", "TOOL_PLANNER_NOT_READY", "TOOL_PROTECTED_NOT_READY",
  "TOOL_ARGUMENTS_INVALID", "TOOL_PLAN_INVALID", "TOOL_PLAN_NONDETERMINISTIC", "TOOL_POLICY_DENIED",
  "TOOL_CREDENTIAL_NOT_READY",
]);
export function serializeToolInvocationPlan(plan: ToolInvocationPlan): string { return JSON.stringify(ToolInvocationPlanSchema.parse(plan)); }
/** Loaded plans remain data only; no execution API accepts them as a grant. */
export function loadToolInvocationPlan(raw: string): ToolInvocationPlan { return ToolInvocationPlanSchema.parse(JSON.parse(raw)); }
