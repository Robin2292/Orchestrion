import { z } from "zod";
import type { ProjectRecord, SessionRecord } from "./contracts";

/** Internal transport only. Domain owners supply their existing payload schemas. */
export const LOCAL_CONTRACT_VERSION = "orchestrion.local.v1" as const;
export const LocalIdSchema = z.string().min(1).max(255).refine((s) => s.trim() === s && s.length > 0);
export const LocalHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const LocalRevisionSchema = z.number().int().nonnegative().safe();

// InvocationPrincipal.as_protocol_value(), not the future PrincipalRef proposal.
export const LocalPrincipalSchema = z.object({
  type: z.enum(["user", "agent", "service"]),
  id: LocalIdSchema,
}).strict();

export const LocalContextSchema = z.object({
  org_id: LocalIdSchema,
  principal: LocalPrincipalSchema,
  project_id: LocalIdSchema,
}).strict();

/** Exactly one engine and incarnation. This reference neither elects nor starts it. */
export const RuntimeOwnerSchema = z.object({
  engine: z.enum(["web", "local"]),
  instance_id: z.string().uuid(),
  epoch: LocalRevisionSchema,
}).strict();

export const LocalVersionPinSchema = z.object({
  revision: LocalRevisionSchema,
  hash: LocalHashSchema,
}).strict();

/** Project owns the definition; Run IDs are never replaced with Codex session IDs. */
export const LocalRunIdentitySchema = z.object({
  project_id: LocalIdSchema,
  workflow_id: LocalIdSchema,
  workflow_version_id: LocalIdSchema,
  run_id: LocalIdSchema,
}).strict();

/** Metadata only: there is no loader, resolver, permission, or execution authority. */
export const InertSourceReferenceSchema = z.object({
  source_kind: z.enum(["skill", "agent"]),
  ref: LocalIdSchema,
  version: LocalIdSchema,
}).strict();

export const FutureAgentWorkflowSeamSchema = z.object({
  agent_id: LocalIdSchema,
  operations: z.array(z.enum(["discover", "trigger", "monitor"])).max(3),
  authority: z.literal("none"),
}).strict();

/** Registry owner_key + existing immutable contract anchor; no new Tool identity. */
export const LocalToolAnchorSchema = z.object({
  org_id: LocalIdSchema,
  owner_key: LocalIdSchema,
  tool_name: LocalIdSchema,
  tool_contract_version_id: LocalIdSchema,
  tool_contract_hash: LocalHashSchema,
}).strict();

export const LocalCommandHeaderSchema = z.object({
  schema_version: z.literal(LOCAL_CONTRACT_VERSION),
  request_id: z.string().uuid(),
  idempotency_key: z.string().uuid(),
  context: LocalContextSchema,
  runtime_owner: RuntimeOwnerSchema,
  expected: LocalVersionPinSchema,
  run: LocalRunIdentitySchema.nullable(),
}).strict();

export function localCommandSchema<S extends z.ZodTypeAny>(name: string, payload: S) {
  return LocalCommandHeaderSchema.extend({ command: z.literal(name), payload }).strict()
    .refine((value) => value.run === null || value.run.project_id === value.context.project_id);
}

/** Web EventEnvelope names/identity retained; only the Local routing header is new.
 * Data MUST use the domain's redacted public/audit schema, never raw provider data.
 * Producers publish through EventBus; sequence is assigned by durable storage.
 */
export function localEventSchema<S extends z.ZodTypeAny>(eventType: string, data: S) {
  return z.object({
    schema_version: z.literal(LOCAL_CONTRACT_VERSION),
    context: LocalContextSchema,
    runtime_owner: RuntimeOwnerSchema,
    revision: LocalRevisionSchema,
    request_id: z.string().uuid(),
    causation_id: z.string().uuid(),
    event_id: z.string().uuid(),
    event_type: z.literal(eventType),
    channel: z.enum(["run", "domain"]),
    run: LocalRunIdentitySchema.nullable(),
    node_id: LocalIdSchema.nullable(),
    recorded_sequence: LocalRevisionSchema.nullable(),
    timestamp: z.string().datetime({ offset: true }),
    data,
  }).strict().refine((value) =>
    (value.run === null || value.run.project_id === value.context.project_id)
    && (value.channel !== "run" || value.run !== null));
}

export type LocalContext = z.infer<typeof LocalContextSchema>;
export type RuntimeOwner = z.infer<typeof RuntimeOwnerSchema>;
export type LocalCommandHeader = z.infer<typeof LocalCommandHeaderSchema>;
export type LocalToolAnchor = z.infer<typeof LocalToolAnchorSchema>;
// Compile-time reuse of existing desktop identities, without inventing replacements.
export type DesktopProjectId = ProjectRecord["id"];
export type DesktopSessionId = SessionRecord["id"];

export const LocalErrorCodeSchema = z.enum([
  "INVALID_PAYLOAD", "UNSUPPORTED_VERSION", "CONTEXT_MISMATCH",
  "RUNTIME_OWNER_MISMATCH", "REVISION_CONFLICT", "NOT_AUTHENTICATED", "SERVICE_UNAVAILABLE", "OUTCOME_UNKNOWN",
  "GOVERNED_SESSION_NOT_READY",
]);
export type LocalErrorCode = z.infer<typeof LocalErrorCodeSchema>;
export const LocalFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: LocalErrorCodeSchema, retryable: z.literal(false) }).strict(),
}).strict();
export type LocalFailure = z.infer<typeof LocalFailureSchema>;

/** No exception text, payload, credential, stack or untrusted identifier is echoed. */
export function localFailure(code: LocalErrorCode): LocalFailure {
  return { ok: false, error: { code, retryable: false } };
}
