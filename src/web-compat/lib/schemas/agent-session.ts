import { z } from "zod";

export const AGENT_SESSION_CONTRACT_VERSION = "orchestrion.agent-session.v1" as const;
const Id = z.string().min(1).max(255);
const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const DateTime = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .datetime();
const Header = { schemaVersion: z.literal(AGENT_SESSION_CONTRACT_VERSION) };
const AgentPrincipal = z.object({ type: z.literal("agent"), id: Id }).strict();
const HumanPrincipal = z.object({ type: z.literal("human"), id: Id }).strict();
const SystemPrincipal = z.object({ type: z.literal("system"), id: Id }).strict();
const InitiatorPrincipal = z.discriminatedUnion("type", [HumanPrincipal, AgentPrincipal]);

export const AgentIdentitySchema = z.object({
  ...Header,
  id: Id,
  orgId: Id,
  name: z.string().min(1).max(255),
  visibility: z.enum(["organization", "project"]),
  homeProjectId: Id.nullable(),
  derivedFromAgentVersionId: Id.nullable(),
  agentPrincipal: AgentPrincipal,
}).strict().superRefine((value, context) => {
  if (value.visibility === "project" && value.homeProjectId === null) {
    context.addIssue({ code: "custom", path: ["homeProjectId"], message: "project visibility requires immutable homeProjectId" });
  }
});

export const ProjectAgentAssignmentSchema = z.object({
  ...Header, id: Id, orgId: Id, projectId: Id, agentId: Id,
  currentAssignmentVersionId: Id.nullable(),
  status: z.enum(["active", "disabled", "removed"]),
}).strict();

const ConnectionBinding = z.object({ connectionId: Id, sourceId: Id, scope: Id }).strict();
const CredentialReference = z.object({ credentialId: Id, connectionId: Id, purpose: Id }).strict();
const WorkspaceScope = z.object({
  mode: z.enum(["project", "declared_paths", "none"]), pathPrefixes: z.array(z.string()),
}).strict().superRefine((value, context) => {
  if ((value.mode === "declared_paths") !== (value.pathPrefixes.length > 0)) {
    context.addIssue({ code: "custom", path: ["pathPrefixes"], message: "pathPrefixes must exist exactly for declared_paths" });
  }
});
const DataScope = z.object({ domains: z.array(Id), resourceReferences: z.array(Id) }).strict();
const AuthorityCeiling = z.object({
  organizationCeilingHash: Hash,
  principalGrantHash: Hash,
  agentVersionGrantHash: Hash,
  directGrantVersionIds: z.array(Id),
}).strict();
const MemoryScopeCeiling = z.object({
  projectId: Id,
  allowedWorkflowIds: z.array(Id),
  allowedDataDomains: z.array(Id),
  projectPromotionAllowed: z.boolean(),
  organizationPromotionAllowed: z.literal(false),
}).strict();
const PlacementConstraints = z.object({
  allowed: z.array(z.enum(["local_trusted", "local_isolated", "remote_self_hosted", "managed_cloud"])).min(1),
  fallback: z.literal("forbidden"),
}).strict();
const BudgetCeilings = z.object({
  modelTokens: z.number().int().positive().nullable(),
  toolCalls: z.number().int().positive().nullable(),
  costUsd: z.number().nonnegative().nullable(),
}).strict();

export const ProjectAgentAssignmentVersionSchema = z.object({
  ...Header,
  id: Id,
  orgId: Id,
  assignmentId: Id,
  revision: z.number().int().positive(),
  agentVersionId: Id,
  parameterValues: z.record(z.string(), z.unknown()),
  connectionBindings: z.array(ConnectionBinding),
  credentialReferences: z.array(CredentialReference),
  workspaceScope: WorkspaceScope,
  policyReferences: z.array(Id),
  dataScope: DataScope,
  authorityCeiling: AuthorityCeiling,
  memoryScopeCeiling: MemoryScopeCeiling,
  placementConstraints: PlacementConstraints,
  budgetCeilings: BudgetCeilings,
  resolvedConfigHash: Hash,
  authorityCeilingHash: Hash,
  memoryScopeHash: Hash,
  createdAt: DateTime,
  createdByPrincipalId: Id,
}).strict();

const AgentRoleSubject = z.object({
  type: z.literal("agent"), agentId: Id, agentVersionId: Id,
  assignmentId: Id, assignmentVersionId: Id, agentPrincipal: AgentPrincipal, resolvedConfigHash: Hash,
}).strict();
const HumanRoleSubject = z.object({ type: z.literal("human"), principal: HumanPrincipal }).strict();
const SystemRoleSubject = z.object({ type: z.literal("system"), systemKey: Id, principal: SystemPrincipal }).strict();
const WorkflowRoleSubject = z.object({ type: z.literal("workflow"), workflowId: Id, workflowVersionId: Id }).strict();
export const WorkflowRoleBindingSchema = z.object({
  ...Header,
  id: Id,
  orgId: Id,
  projectId: Id,
  workflowVersionId: Id,
  roleKey: Id,
  subject: z.discriminatedUnion("type", [AgentRoleSubject, HumanRoleSubject, SystemRoleSubject, WorkflowRoleSubject]),
  duty: z.enum(["initiator", "manager", "implementer", "reviewer", "executor", "approver"]),
  separationOfDuty: z.object({ mustDifferFromRoleKeys: z.array(Id) }).strict(),
}).strict();

const GovernedBinding = z.object({
  provenance: z.literal("released"), agentVersionId: Id, projectAgentAssignmentId: Id,
  assignmentVersionId: Id, resolvedConfigHash: Hash,
}).strict();
const LegacyBinding = z.object({
  provenance: z.literal("legacy_unversioned"), agentVersionId: z.null(), projectAgentAssignmentId: Id.nullable(),
  assignmentVersionId: z.null(), resolvedConfigHash: z.null(), originalThreadId: Id,
  legacyConfigurationEvidence: z.record(z.string(), z.unknown()),
}).strict();
const SessionBinding = z.discriminatedUnion("provenance", [GovernedBinding, LegacyBinding]);
const DirectMemoryScope = z.object({
  type: z.literal("direct"), projectId: Id, sessionId: Id, sharing: z.literal("session_only"),
}).strict();
const WorkflowMemoryScope = z.object({
  type: z.literal("workflow"), projectId: Id, workflowId: Id,
  dataDomains: z.array(Id).min(1), sharing: z.literal("workflow_data_domain"),
}).strict();
const SessionBase = {
  ...Header,
  id: Id,
  orgId: Id,
  projectId: Id,
  agentId: Id,
  agentPrincipal: AgentPrincipal.nullable(),
  initiatedBy: InitiatorPrincipal.nullable(),
  materializedBy: SystemPrincipal.nullable(),
  archivedAt: DateTime.nullable(),
};
function requireAttribution(value: {
  binding: z.infer<typeof SessionBinding>;
  agentPrincipal: z.infer<typeof AgentPrincipal> | null;
  initiatedBy: z.infer<typeof InitiatorPrincipal> | null;
  materializedBy: z.infer<typeof SystemPrincipal> | null;
}, context: z.RefinementCtx): void {
  if (value.binding.provenance === "released" && (!value.agentPrincipal || !value.initiatedBy || !value.materializedBy)) {
    context.addIssue({ code: "custom", path: ["agentPrincipal"], message: "released Sessions require complete principal attribution" });
  }
}
export const DirectAgentSessionSchema = z.object({
  ...SessionBase, source: z.literal("direct"), lifecycle: z.enum(["active", "archived"]),
  memoryScope: DirectMemoryScope, binding: SessionBinding,
}).strict().superRefine((value, context) => {
  if ((value.lifecycle === "archived") !== (value.archivedAt !== null)) {
    context.addIssue({ code: "custom", path: ["archivedAt"], message: "archivedAt must exist exactly for archived Direct Sessions" });
  }
  if (value.memoryScope.projectId !== value.projectId || value.memoryScope.sessionId !== value.id) {
    context.addIssue({ code: "custom", path: ["memoryScope"], message: "Direct memory scope mismatch" });
  }
  requireAttribution(value, context);
});
export const WorkflowAgentSessionSchema = z.object({
  ...SessionBase,
  source: z.literal("workflow"),
  executionState: z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled"]),
  memoryScope: WorkflowMemoryScope,
  binding: GovernedBinding,
  workflowId: Id,
  workflowVersionId: Id,
  workflowRunId: Id,
  workflowRoleBindingId: Id,
  workSlotKey: Id,
}).strict().superRefine((value, context) => {
  if (value.archivedAt !== null) context.addIssue({ code: "custom", path: ["archivedAt"], message: "Workflow Sessions are retained" });
  if (value.memoryScope.projectId !== value.projectId || value.memoryScope.workflowId !== value.workflowId) {
    context.addIssue({ code: "custom", path: ["memoryScope"], message: "Workflow memory origin mismatch" });
  }
  requireAttribution(value, context);
});
export const AgentSessionSchema = z.union([DirectAgentSessionSchema, WorkflowAgentSessionSchema]);

const RuntimeOwner = z.object({ engine: z.enum(["web", "local"]), instanceId: Id, epoch: z.number().int().nonnegative() }).strict();
export const AgentSessionAttemptSchema = z.object({
  ...Header,
  id: Id,
  orgId: Id,
  sessionId: Id,
  attemptNumber: z.number().int().positive(),
  executionPlacementBindingId: Id,
  workspaceBindingId: Id,
  sourceRevisionOrSnapshot: Id,
  runtimeOwner: RuntimeOwner,
  fencingToken: Id,
  effectiveAuthorityHash: Hash,
  resolvedConfigHash: Hash,
  accountingIdentity: Id,
  providerExecutionRef: Id.nullable(),
  fallback: z.literal("forbidden"),
  outcome: z.enum(["running", "waiting", "completed", "failed", "cancelled"]),
  createdAt: DateTime,
}).strict();

export const AgentSessionContractSchemas = {
  agentIdentity: AgentIdentitySchema,
  assignment: ProjectAgentAssignmentSchema,
  assignmentVersion: ProjectAgentAssignmentVersionSchema,
  workflowRoleBinding: WorkflowRoleBindingSchema,
  agentSession: AgentSessionSchema,
  sessionAttempt: AgentSessionAttemptSchema,
} as const;
export type AgentSessionContractKind = keyof typeof AgentSessionContractSchemas;
export function parseAgentSessionContract(kind: AgentSessionContractKind, value: unknown): unknown {
  return AgentSessionContractSchemas[kind].parse(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error("canonical hash material requires finite JavaScript-safe numbers");
  }
  if (typeof value === "string" && /\p{Cs}/u.test(value)) {
    throw new Error("canonical hash material requires Unicode scalar values");
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, nested]) => {
        if (/\p{Cs}/u.test(key)) throw new Error("canonical hash material requires Unicode scalar values");
        return [key, canonicalize(nested)];
      }));
  }
  return value;
}
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}
async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function compileAssignmentVersionHashes(input: unknown): Promise<{
  resolvedConfigHash: string; authorityCeilingHash: string; memoryScopeHash: string;
}> {
  const value = ProjectAgentAssignmentVersionSchema.parse(input);
  return {
    resolvedConfigHash: await sha256({
      schemaVersion: value.schemaVersion,
      agentVersionId: value.agentVersionId,
      parameterValues: value.parameterValues,
      connectionBindings: value.connectionBindings,
      credentialReferences: value.credentialReferences,
      workspaceScope: value.workspaceScope,
      policyReferences: value.policyReferences,
      dataScope: value.dataScope,
      authorityCeiling: value.authorityCeiling,
      memoryScopeCeiling: value.memoryScopeCeiling,
      placementConstraints: value.placementConstraints,
      budgetCeilings: value.budgetCeilings,
    }),
    authorityCeilingHash: await sha256({
      authorityCeiling: value.authorityCeiling,
      policyReferences: value.policyReferences,
      placementConstraints: value.placementConstraints,
      budgetCeilings: value.budgetCeilings,
    }),
    memoryScopeHash: await sha256(value.memoryScopeCeiling),
  };
}
