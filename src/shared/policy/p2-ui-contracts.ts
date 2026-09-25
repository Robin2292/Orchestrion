import { z } from "zod";
import { AgentRejectionCodeSchema } from "../agent-contracts";
import {
  LocalErrorCodeSchema,
  LocalFailureSchema,
  LocalHashSchema,
  LocalIdSchema,
  LocalRevisionSchema,
  LocalVersionPinSchema,
} from "../local-contracts";
import { ToolScopeSchema } from "../tool-scope";
import { P0RuleSchema } from "./p0-evaluator";
import { PolicyRejectionCodeSchema, PolicyReleaseSchema, PolicyTargetSchema } from "./p1-contracts";

export const LOCAL_POLICY_UI_CHANNEL = "orchestrion:local-policy-ui" as const;
export const LOCAL_POLICY_UI_VERSION = "orchestrion.local.policy.ui.v1" as const;

const identity = {
  requestId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  expected: LocalVersionPinSchema,
};
const releasePin = z.object({
  id: LocalIdSchema,
  releaseHash: LocalHashSchema,
  stateRevision: LocalRevisionSchema,
}).strict();

export const LocalPolicyUiRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("snapshot") }).strict(),
  z.object({ operation: z.literal("draft"), ...identity, payload: z.object({
    source: releasePin,
    rules: z.array(P0RuleSchema).min(1).max(256),
  }).strict() }).strict(),
  z.object({ operation: z.literal("transition"), ...identity, payload: releasePin.extend({
    action: z.enum(["review", "publish"]),
  }).strict() }).strict(),
  z.object({ operation: z.literal("select"), ...identity, payload: releasePin.extend({
    action: z.enum(["activate", "rollback"]),
    expectedSequence: LocalRevisionSchema,
  }).strict() }).strict(),
  z.object({ operation: z.literal("simulate"), expected: LocalVersionPinSchema, payload: releasePin.extend({
    resource: z.object({
      resourceType: z.literal("workspace_path"),
      value: z.string().min(1).max(8192),
      mode: z.enum(["read", "write"]),
    }).strict(),
  }).strict() }).strict(),
]);
export type LocalPolicyUiRequest = z.infer<typeof LocalPolicyUiRequestSchema>;

export const LocalPolicyReleaseViewSchema = PolicyReleaseSchema;
export type LocalPolicyReleaseView = z.infer<typeof LocalPolicyReleaseViewSchema>;

const selection = z.object({
  releaseId: LocalIdSchema,
  sequence: LocalRevisionSchema,
  action: z.enum(["activate", "rollback", "deactivate"]),
}).strict();
const applicable = z.object({
  releaseId: LocalIdSchema,
  revision: z.number().int().positive().safe(),
  releaseHash: LocalHashSchema,
  lifecycle: z.enum(["draft", "reviewed", "published", "revoked"]),
  target: PolicyTargetSchema,
}).strict();
const diff = z.object({
  change: z.enum(["added", "removed", "changed"]),
  ruleId: LocalIdSchema,
  before: P0RuleSchema.nullable(),
  after: P0RuleSchema.nullable(),
}).strict();
const readiness = z.object({
  state: z.enum(["ready", "stale", "not_ready"]),
  code: z.enum(["ready", "release_stale", "release_revoked", "approval_unsupported", "authority_unavailable"]),
  label: z.string().min(1).max(160),
  remediation: z.string().min(1).max(512),
}).strict();

export const LocalPolicyUiItemSchema = z.object({
  release: LocalPolicyReleaseViewSchema,
  selection: selection.nullable(),
  baselineRelease: applicable.nullable(),
  upstreamRelease: applicable.nullable(),
  upstreamScope: ToolScopeSchema,
  effectiveScope: ToolScopeSchema,
  applicableReleases: z.array(applicable).min(1).max(64),
  diff: z.array(diff).max(512),
  readiness,
  grantsAuthority: z.literal(false),
}).strict();
export type LocalPolicyUiItem = z.infer<typeof LocalPolicyUiItemSchema>;

export const LocalPolicyUiWorkspaceSchema = z.object({
  schemaVersion: z.literal(LOCAL_POLICY_UI_VERSION),
  projectId: LocalIdSchema,
  expected: LocalVersionPinSchema,
  supportedLayers: z.array(z.enum(["organization", "workflow", "agent", "node"])).min(1).max(4),
  items: z.array(LocalPolicyUiItemSchema).max(10_000),
}).strict();
export type LocalPolicyUiWorkspace = z.infer<typeof LocalPolicyUiWorkspaceSchema>;

const decision = z.object({
  outcome: z.enum(["allow", "require_approval", "deny"]),
  restrictionOrder: z.number().int().min(0).max(2),
  reasonCodes: z.array(LocalIdSchema).max(512),
  effectiveScope: ToolScopeSchema,
}).strict();
export const LocalPolicySimulationViewSchema = z.object({
  schemaVersion: z.literal("orchestrion.local.policy.simulation.v1"),
  state: z.enum(["allowed", "denied", "stale", "not_ready"]),
  canonicalResource: z.object({ resourceType: z.literal("workspace_path"), value: z.string().min(1).max(8192), mode: z.enum(["read", "write"]) }).strict().nullable(),
  decision: decision.nullable(),
  matchedRules: z.array(z.object({ releaseId: LocalIdSchema, ruleId: LocalIdSchema }).strict()).max(16_384),
  diagnostics: z.array(z.object({ code: LocalIdSchema, message: z.string().min(1).max(320), correctiveAction: z.string().min(1).max(512) }).strict()).max(32),
  grantsAuthority: z.literal(false),
  dispatchCount: z.literal(0),
}).strict();
export type LocalPolicySimulationView = z.infer<typeof LocalPolicySimulationViewSchema>;

export const LocalPolicyUiValueSchema = z.object({
  workspace: LocalPolicyUiWorkspaceSchema,
  selectedReleaseId: LocalIdSchema.nullable(),
  simulation: LocalPolicySimulationViewSchema.nullable(),
}).strict();
export type LocalPolicyUiValue = z.infer<typeof LocalPolicyUiValueSchema>;

export const LocalPolicyUiRejectionCodeSchema = z.union([
  LocalErrorCodeSchema,
  PolicyRejectionCodeSchema,
  AgentRejectionCodeSchema,
  z.enum(["POLICY_APPROVAL_RUNTIME_UNSUPPORTED"]),
]);
export const LocalPolicyUiFailureSchema = LocalFailureSchema.extend({ error: z.object({
  code: LocalPolicyUiRejectionCodeSchema,
  retryable: z.literal(false),
}).strict() }).strict();
export const LocalPolicyUiReplySchema = z.union([
  z.object({ ok: z.literal(true), value: LocalPolicyUiValueSchema }).strict(),
  LocalPolicyUiFailureSchema,
]);
export type LocalPolicyUiReply = z.infer<typeof LocalPolicyUiReplySchema>;

export function loadLocalPolicyUiReply(raw: unknown): LocalPolicyUiReply {
  return LocalPolicyUiReplySchema.parse(raw);
}

export function serializeLocalPolicyUiValue(value: LocalPolicyUiValue): string {
  return JSON.stringify(LocalPolicyUiValueSchema.parse(value));
}

export function loadLocalPolicyUiValue(value: string): LocalPolicyUiValue {
  return LocalPolicyUiValueSchema.parse(JSON.parse(value));
}
