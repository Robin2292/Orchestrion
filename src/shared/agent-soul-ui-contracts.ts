import { z } from "zod";
import { AgentFailureSchema } from "./agent-contracts";
import { AGENT_SOUL_MAX_BYTES, AgentSoulDraftSchema } from "./agent-soul-contracts";
import { LocalIdSchema, LocalVersionPinSchema } from "./local-contracts";

export const LOCAL_AGENT_SOUL_CHANNEL = "orchestrion:local-agent-soul" as const;
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const LocalAgentSoulRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read"), agentId: LocalIdSchema }).strict(),
  z.object({ operation: z.literal("save"), agentId: LocalIdSchema,
    content: z.string().max(AGENT_SOUL_MAX_BYTES + 3), expectedHash: hash,
    publishedVersionId: LocalIdSchema.nullable() }).strict(),
  z.object({ operation: z.literal("publish"), agentId: LocalIdSchema,
    publishedVersionId: LocalIdSchema, expectedHash: hash, expected: LocalVersionPinSchema,
    requestId: z.string().uuid(), idempotencyKey: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("open"), agentId: LocalIdSchema, expectedHash: hash }).strict(),
]);
export type LocalAgentSoulRequest = z.infer<typeof LocalAgentSoulRequestSchema>;
export const LocalAgentSoulValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("draft"), draft: AgentSoulDraftSchema }).strict(),
  z.object({ kind: z.literal("opened"), draft: AgentSoulDraftSchema }).strict(),
  z.object({ kind: z.literal("published"), versionId: LocalIdSchema,
    draft: AgentSoulDraftSchema }).strict(),
]);
export type LocalAgentSoulValue = z.infer<typeof LocalAgentSoulValueSchema>;
export const LocalAgentSoulReplySchema = z.union([
  z.object({ ok: z.literal(true), value: LocalAgentSoulValueSchema }).strict(),
  AgentFailureSchema,
]);
