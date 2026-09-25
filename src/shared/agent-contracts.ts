import { z } from "zod";
import { AgentVersionFieldsSchema } from "../web-compat/lib/schemas/agents";
import { AgentSoulSnapshotSchema } from "./agent-soul-contracts";
import { LocalContextSchema, LocalIdSchema, LocalFailureSchema, LocalErrorCodeSchema } from "./local-contracts";

export const AGENT_CONTRACT_VERSION = "orchestrion.local.agent.v1" as const;
// A0's safe rejection vocabulary extends the existing Local failure envelope;
// no exception messages, paths, raw Zod issues or arbitrary details cross the API.
export const AgentRejectionCodeSchema = z.enum([
  "INVALID_PAYLOAD", "UNSUPPORTED_VERSION", "CONTEXT_MISMATCH", "RUNTIME_OWNER_MISMATCH",
  "REVISION_CONFLICT", "NOT_AUTHENTICATED", "AGENT_NOT_FOUND", "AGENT_VERSION_NOT_FOUND",
  "AGENT_NODE_TYPE_IMMUTABLE", "AGENT_REFERENCED",
  "SOUL_CONFLICT", "SOUL_TOO_LARGE", "SOUL_INVALID_CONTENT", "SOUL_FILE_UNAVAILABLE",
]);
export const AgentFailureSchema = LocalFailureSchema.extend({ error: z.object({
  code: z.union([LocalErrorCodeSchema, AgentRejectionCodeSchema]), retryable: z.literal(false),
}).strict() }).strict();
export type AgentFailure = z.infer<typeof AgentFailureSchema>;
export const AgentNodeTypeSchema = AgentVersionFieldsSchema.shape.nodeType;
const date = z.string().datetime({ offset: true });
const name = z.string().min(1).max(255).refine((v) => v.trim().length > 0);
// JSON properties (schema/model parameters) are open dictionaries, not DTO fields.
export type AgentJson = null | boolean | number | string | AgentJson[] | { [key: string]: AgentJson };
const json: z.ZodType<AgentJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json),
]));
const object = z.record(json);
const nonLlmConfig = z.discriminatedUnion("node_type", [
  z.object({ node_type: z.literal("terminal"), initial_prompt: z.string(),
    execution_mode: z.enum(["interactive", "headless"]).optional() }).strict(),
  z.object({ node_type: z.literal("code"), script: z.string().min(1).max(50000),
    timeout_seconds: z.number().int().min(1).max(300).optional(),
    input_schema: object.nullish(), output_schema: object.nullish() }).strict(),
  z.object({ node_type: z.literal("coding_agent"), provider: z.string().min(1).max(50), prompt: z.string(),
    model: z.string().max(100).nullish(), timeout_seconds: z.number().int().min(30).max(7200).optional(),
    max_turns: z.number().int().min(1).max(500).nullish(), allowed_tools: z.array(z.string()).nullish(),
    permission_mode: z.enum(["default", "accept_edits", "full_auto"]).nullish() }).strict(),
  z.object({ node_type: z.literal("sub_workflow"), workflow_id: z.string().min(1).max(36),
    workflow_version_id: z.string().min(1).max(36), auto_upgrade: z.boolean().optional(),
    input_schema: object.nullish() }).strict(),
]);
// Reuse the current Web wire fields, including frozen skill/release bindings.
// No legacy cache-field stripping at this new write boundary.
export const AgentDefinitionSchema = AgentVersionFieldsSchema.omit({
  id: true, agentId: true, versionNumber: true, createdAt: true,
}).superRefine((v, ctx) => {
  if (!object.safeParse(v).success) ctx.addIssue({ code: "custom", message: "JSON_REQUIRED" });
  if (v.nodeType === "agent") {
    if (v.config !== null || !v.providerType || !v.modelId || v.providerType === "workflow")
      ctx.addIssue({ code: "custom", message: "INVALID_AGENT_CONFIG" });
  } else if (!nonLlmConfig.safeParse(v.config).success || v.config?.node_type !== v.nodeType) {
    ctx.addIssue({ code: "custom", message: "INVALID_AGENT_CONFIG" });
  }
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export const AgentVersionMetadataSchema = z.object({ name, description: z.string().nullable(),
  userGuide: z.string().nullable() }).strict();
export const AgentCreateSchema = z.object({ name, description: z.string().nullable(),
  userGuide: z.string().nullable(), definition: AgentDefinitionSchema }).strict();
export const AgentUpdateSchema = AgentVersionMetadataSchema.extend({ id: LocalIdSchema }).strict();
export const AgentVersionCreateSchema = z.object({ agentId: LocalIdSchema, definition: AgentDefinitionSchema,
  sourceVersionId: LocalIdSchema.optional(),
  metadata: AgentVersionMetadataSchema.optional() }).strict();
export const AgentReferenceSchema = z.object({ agentId: LocalIdSchema, versionId: LocalIdSchema }).strict();
export const AgentVersionCloneSchema = AgentReferenceSchema.strict();
export const AgentSoulPublishSchema = z.object({ agentId: LocalIdSchema,
  publishedVersionId: LocalIdSchema, expectedHash: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict();
export const AgentIdSchema = z.object({ id: LocalIdSchema }).strict();
export const AgentPageSchema = z.object({ limit: z.number().int().min(1).max(100), offset: z.number().int().nonnegative().safe() }).strict();
export const LocalAgentVersionSchema = z.object({ schemaVersion: z.literal(AGENT_CONTRACT_VERSION),
  context: LocalContextSchema, id: LocalIdSchema, agentId: LocalIdSchema,
  versionNumber: z.number().int().positive().safe(), definition: AgentDefinitionSchema,
  soul: AgentSoulSnapshotSchema.optional(), createdAt: date }).strict();
export const LocalAgentSchema = z.object({ schemaVersion: z.literal(AGENT_CONTRACT_VERSION), context: LocalContextSchema,
  id: LocalIdSchema, nodeType: AgentNodeTypeSchema, name, description: z.string().nullable(), userGuide: z.string().nullable(),
  latestVersionId: LocalIdSchema.nullable(), legacyDraft: z.object({ instructions: z.string() }).strict().nullable(),
  createdAt: date, updatedAt: date, deletedAt: date.nullable() }).strict();
export type LocalAgent = z.infer<typeof LocalAgentSchema>;
export type LocalAgentVersion = z.infer<typeof LocalAgentVersionSchema>;
export function serializeAgentVersion(value: LocalAgentVersion): string { return JSON.stringify(LocalAgentVersionSchema.parse(value)); }
export function loadAgentVersion(value: string): LocalAgentVersion { return LocalAgentVersionSchema.parse(JSON.parse(value)); }

export const LegacyProjectSchema = z.object({ id: LocalIdSchema, name, path: z.string().min(1), createdAt: date }).strict();
export const LegacyAgentSchema = z.object({ id: LocalIdSchema, projectId: LocalIdSchema, name,
  instructions: z.string(), createdAt: date }).strict();
export const LegacySessionSchema = z.object({ id: LocalIdSchema, agentId: LocalIdSchema, title: z.string(),
  threadId: z.string().min(1).nullable(), model: z.string().nullable().optional(),
  modelProvider: z.string().nullable().optional(), reasoningEffort: z.string().nullable().optional(),
  titleSource: z.enum(["provisional", "codex", "manual"]).optional(), createdAt: date, updatedAt: date }).strict();
// Original store has no version field. Accept exactly that format, or explicit v1.
export const LegacyMetadataSchema = z.object({ schemaVersion: z.literal("orchestrion-desktop@1").optional(),
  projects: z.array(LegacyProjectSchema), agents: z.array(LegacyAgentSchema), sessions: z.array(LegacySessionSchema),
}).strict().superRefine((v, ctx) => {
  for (const rows of [v.projects, v.agents, v.sessions])
    if (new Set(rows.map((r) => r.id)).size !== rows.length) ctx.addIssue({ code: "custom", message: "DUPLICATE_ID" });
  const projects = new Set(v.projects.map((r) => r.id)), agents = new Set(v.agents.map((r) => r.id));
  if (v.agents.some((r) => !projects.has(r.projectId)) || v.sessions.some((r) => !agents.has(r.agentId)))
    ctx.addIssue({ code: "custom", message: "REFERENCE_NOT_FOUND" });
});
export type LegacyMetadata = z.infer<typeof LegacyMetadataSchema>;
