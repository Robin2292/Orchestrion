import { z } from "zod";
import { localCommandSchema } from "./local-contracts";

/** Public projection only. Never put secrets, keychain locators or native errors here. */
export const CredentialRequestSchema = z.object({
  credential_ref: z.string().uuid(), connector_id: z.string().uuid(),
  revision: z.number().int().nonnegative().safe(),
}).strict();
export const CredentialReadinessSchema = CredentialRequestSchema.extend({
  state: z.enum(["ready", "unavailable", "revoked", "tombstoned"]),
  mask: z.literal("••••••••"),
}).strict();
export const CredentialResultSchema = z.union([
  z.object({ ok: z.literal(true), value: CredentialReadinessSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.object({
    code: z.enum(["CREDENTIAL_INVALID", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_CONFLICT"]),
    retryable: z.literal(false),
  }).strict() }).strict(),
]);
export type CredentialResult = z.infer<typeof CredentialResultSchema>;
export const CredentialReplySchema = z.object({ ok: z.literal(true), value: CredentialResultSchema }).strict();
export type CredentialRequest = z.infer<typeof CredentialRequestSchema>;
export const CREDENTIAL_READINESS_CHANNEL = "orchestrion:credential-readiness";
const ReadinessCommandSchema = localCommandSchema("credential.readiness", CredentialRequestSchema);
/** Reject unknown/secret fields before forwarding anything to the utility host. */
export const CredentialReadinessWireSchema = z.string().max(16384).refine(raw => {
  try { return ReadinessCommandSchema.safeParse(JSON.parse(raw)).success; } catch { return false; }
});
