import { z } from "zod";
import {
  AgentCreateSchema,
  AgentFailureSchema,
  AgentIdSchema,
  AgentUpdateSchema,
  AgentVersionCreateSchema,
  LocalAgentSchema,
  LocalAgentVersionSchema,
} from "./agent-contracts";
import { LocalIdSchema, LocalVersionPinSchema } from "./local-contracts";
import { LocalToolSourceCatalogSchema } from "./tool-source-contracts";
import { ToolGrantSchema } from "./tool-grant-contracts";

export const LOCAL_AGENT_UI_CHANNEL = "orchestrion:local-agent-ui" as const;
export const LOCAL_AGENT_UI_VERSION = "orchestrion.local.agent.ui.v3" as const;
export const LOCAL_AGENT_UI_PAGE_SIZE = 100 as const;
export const LOCAL_AGENT_UI_MAX_ITEMS = 10_000 as const;

const requestIdentity = {
  requestId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  expected: LocalVersionPinSchema,
};

export const LocalAgentUiRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("snapshot") }).strict(),
  z.object({ operation: z.literal("detail"), agentId: LocalIdSchema }).strict(),
  z.object({ operation: z.literal("create"), ...requestIdentity, payload: AgentCreateSchema }).strict(),
  z.object({ operation: z.literal("update"), ...requestIdentity, payload: AgentUpdateSchema }).strict(),
  z.object({ operation: z.literal("version.create"), ...requestIdentity, payload: AgentVersionCreateSchema }).strict(),
  z.object({ operation: z.literal("delete"), ...requestIdentity, payload: AgentIdSchema }).strict(),
]);
export type LocalAgentUiRequest = z.infer<typeof LocalAgentUiRequestSchema>;

export const LocalAgentListItemSchema = z.object({
  agent: LocalAgentSchema,
  latestVersion: LocalAgentVersionSchema.nullable(),
}).strict();
export type LocalAgentListItem = z.infer<typeof LocalAgentListItemSchema>;

export const LocalAgentWorkspaceSchema = z.object({
  schemaVersion: z.literal(LOCAL_AGENT_UI_VERSION),
  projectId: LocalIdSchema,
  expected: LocalVersionPinSchema,
  toolSourceCatalog: LocalToolSourceCatalogSchema.optional(),
  toolGrantTemplates: z.array(z.object({
    catalogId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    grant: ToolGrantSchema,
  }).strict()).max(LOCAL_AGENT_UI_MAX_ITEMS).optional(),
  agents: z.array(LocalAgentListItemSchema).max(LOCAL_AGENT_UI_MAX_ITEMS),
}).strict();
export type LocalAgentWorkspace = z.infer<typeof LocalAgentWorkspaceSchema>;

export const LocalAgentDetailSchema = z.object({
  agent: LocalAgentSchema,
  versions: z.array(LocalAgentVersionSchema).max(LOCAL_AGENT_UI_MAX_ITEMS),
}).strict();
export type LocalAgentDetail = z.infer<typeof LocalAgentDetailSchema>;

export const LocalAgentUiValueSchema = z.object({
  workspace: LocalAgentWorkspaceSchema,
  detail: LocalAgentDetailSchema.nullable(),
  selectedVersionId: LocalIdSchema.nullable(),
}).strict();
export type LocalAgentUiValue = z.infer<typeof LocalAgentUiValueSchema>;

export const LocalAgentUiReplySchema = z.union([
  z.object({ ok: z.literal(true), value: LocalAgentUiValueSchema }).strict(),
  AgentFailureSchema,
]);
export type LocalAgentUiReply = z.infer<typeof LocalAgentUiReplySchema>;

export function serializeLocalAgentUiRequest(value: LocalAgentUiRequest): string {
  return JSON.stringify(LocalAgentUiRequestSchema.parse(value));
}

export function loadLocalAgentUiReply(value: unknown): LocalAgentUiReply {
  return LocalAgentUiReplySchema.parse(value);
}
