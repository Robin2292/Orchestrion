import { z } from "zod";
import { LocalIdSchema } from "./local-contracts";

/** Renderer commands carry intent only. Scope and account selection are host-owned. */
export const CODEX_ACCOUNT_UI_CHANNEL = "orchestrion:codex-account-ui";
export const CodexAccountUiRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read"), projectId: LocalIdSchema }).strict(),
  z.object({ operation: z.literal("start"), projectId: LocalIdSchema, explicitOptIn: z.literal(true) }).strict(),
  z.object({ operation: z.literal("cancel"), projectId: LocalIdSchema }).strict(),
  z.object({ operation: z.literal("disconnect"), projectId: LocalIdSchema }).strict(),
]);
export type CodexAccountUiRequest = z.infer<typeof CodexAccountUiRequestSchema>;

export const CodexAccountUiValueSchema = z.object({
  availability: z.enum(["unavailable", "available"]),
  state: z.enum(["disconnected", "pending", "connected", "stale", "revoked", "unavailable"]),
  accountDisplay: z.literal("••••").nullable(),
  executionReady: z.literal(false),
}).strict();
export type CodexAccountUiValue = z.infer<typeof CodexAccountUiValueSchema>;
export const CodexAccountUiReplySchema = z.object({ ok: z.literal(true), value: CodexAccountUiValueSchema }).strict();
