import { z } from "zod";
import { LocalIdSchema } from "./local-contracts";
import { SessionGovernanceSchema } from "./governed-tool-contracts";

/** Stable remediation only; never include host paths, identifiers or exception text. */
export const GOVERNED_SESSION_NOT_READY_MESSAGE = "Governed tools are not ready. Check the selected Local Agent version, folder, exact direct grants, and published active organization/Agent policies before retrying.";

/** References are selections, never caller-supplied org/project authority. */
export const BindSessionAgentSchema = z.object({
  path: z.string().min(1).max(32768), agentId: LocalIdSchema, versionId: LocalIdSchema,
}).strict();
export type BindSessionAgentInput = z.infer<typeof BindSessionAgentSchema>;

export const SessionBindingErrorSchema = z.enum(["INVALID_PAYLOAD", "NOT_AUTHENTICATED", "SERVICE_UNAVAILABLE",
  "AGENT_NOT_FOUND", "AGENT_VERSION_NOT_FOUND", "SESSION_FOLDER_CONFLICT", "SESSION_VERSION_CONFLICT",
  "SESSION_IDENTITY_CONFLICT", "SESSION_PRESET_UNSUPPORTED"]);
export const BindSessionAgentReplySchema = z.union([
  z.object({ ok: z.literal(true), value: z.object({ id: LocalIdSchema, projectId: LocalIdSchema, name: z.string(), instructions: z.string(),
    createdAt: z.string().datetime(), executionMode: z.literal("governed"), localAgentVersionId: LocalIdSchema }).strict() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: SessionBindingErrorSchema, retryable: z.literal(false) }).strict() }).strict(),
]);

export const GovernedTreeSessionSchema = z.object({
  id: LocalIdSchema, agentId: LocalIdSchema, title: z.string(), threadId: z.string().min(1).nullable(),
  model: z.string().nullable(), modelProvider: z.string().nullable(), reasoningEffort: z.string().nullable(), serviceTier: z.string().nullable().optional(),
  titleSource: z.enum(["provisional", "codex", "manual"]), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  executionMode: z.literal("governed"), governance: SessionGovernanceSchema.nullable().optional(),
}).strict();
