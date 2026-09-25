import { z } from "zod";
import { LocalContextSchema, LocalRevisionSchema, LocalErrorCodeSchema } from "./local-contracts";
import { CredentialRequestSchema } from "./credential-contracts";

export const CONNECTOR_CONTRACT_VERSION = "orchestrion.local.connector.v1" as const;
const id = z.string().uuid();
const name = z.string().min(1).max(100).refine((v) => v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v));
// Connection configuration only: no URL credentials, query tokens or fragments.
// Network/SSRF admission belongs to the future transport, not this metadata DTO.
const url = z.string().max(1000).refine((v) => {
  try { const u = new URL(v); return u.protocol === "https:" && !!u.hostname && !u.username && !u.password
    && !u.search && !u.hash && !/[?#\s\\]/.test(v) && u.href === v; } catch { return false; }
});
const hosts = z.array(z.string().max(253).regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/)).max(16)
  .refine((v) => new Set(v).size === v.length);
export const ConnectorConfigSchema = z.object({ name, templateId: name.nullable(), transport: z.literal("http"),
  url, trustedRedirectHosts: hosts }).strict();
// Historical Runner rows retain identity only. No command, argv, env, tools or
// provider errors enter Local storage; C2 owns any future stdio configuration.
export const RunnerConnectorConfigSchema = z.object({ name, templateId: name.nullable(), transport: z.literal("stdio"),
  runnerId: id, sourceId: id }).strict();
export const ConnectorAuthSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("static"), credential: CredentialRequestSchema }).strict(),
]);
export const ConnectorIdSchema = z.object({ id }).strict();
export const ConnectorPinSchema = ConnectorIdSchema.extend({ revision: LocalRevisionSchema }).strict();
export const ConnectorCreateSchema = ConnectorIdSchema.extend({ config: ConnectorConfigSchema, auth: ConnectorAuthSchema }).strict();
export const ConnectorUpdateSchema = ConnectorPinSchema.extend({ config: ConnectorConfigSchema }).strict();
export const ConnectorRotateSchema = ConnectorPinSchema.extend({ credential: CredentialRequestSchema }).strict();
export const ConnectorPageSchema = z.object({ limit: z.number().int().min(1).max(100), offset: LocalRevisionSchema }).strict();
export const ConnectorImportSchema = ConnectorIdSchema.extend({ sourceId: id }).strict();
export const LocalConnectorSchema = z.object({ schemaVersion: z.literal(CONNECTOR_CONTRACT_VERSION), context: LocalContextSchema,
  id, revision: LocalRevisionSchema, config: z.union([ConnectorConfigSchema, RunnerConnectorConfigSchema]),
  origin: z.enum(["local", "runner"]), auth: ConnectorAuthSchema, status: z.literal("inactive"),
  cleanupRequired: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), deletedAt: z.string().datetime().nullable(),
}).strict().refine((v) => (v.origin === "runner") === (v.config.transport === "stdio")
  && (v.auth.mode !== "static" || v.auth.credential.connector_id === v.id));
export type LocalConnector = z.infer<typeof LocalConnectorSchema>;
// This is a host capability blocker, not a malformed configuration or a request
// to install Docker. No reviewed stdio containment backend ships in Local yet.
// A configured template, command digest or historical Web proof cannot make it
// ready. Keep this independent of cleanup/deletion so both obligations remain
// visible, without mistaking a cleanup proof for execution authority.
export const ConnectorStdioReadinessSchema = z.object({
  state: z.literal("not_ready"), code: z.literal("CONNECTOR_STDIO_CONTAINMENT_UNAVAILABLE"), retryable: z.literal(false),
}).strict();
export const ConnectorProjectionSchema = z.object({ connector: LocalConnectorSchema, authority: z.literal("none"),
  availability: z.literal("unavailable"), execution: z.literal("not_ready"),
  reason: z.enum(["CONNECTOR_TRANSPORT_UNAVAILABLE", "CONNECTOR_CLEANUP_REQUIRED", "CONNECTOR_DELETED"]),
  stdioReadiness: ConnectorStdioReadinessSchema.nullable(),
  tools: z.tuple([]), toolCount: z.literal(0), executableCount: z.literal(0),
}).strict().refine((v) => (v.stdioReadiness !== null) === (v.connector.config.transport === "stdio"));
export const ConnectorRejectionCodeSchema = z.enum(["CONNECTOR_NOT_FOUND", "CONNECTOR_CONFLICT", "CONNECTOR_REVISION_CONFLICT",
  "CONNECTOR_DELETED", "CONNECTOR_CLEANUP_REQUIRED", "CONNECTOR_CREDENTIAL_UNAVAILABLE", "CONNECTOR_IMPORT_UNAVAILABLE"]);
export const ConnectorFailureSchema = z.object({ ok: z.literal(false), error: z.object({
  code: z.union([LocalErrorCodeSchema, ConnectorRejectionCodeSchema]), retryable: z.boolean(),
}).strict() }).strict();
export function serializeConnector(value: LocalConnector) { return JSON.stringify(LocalConnectorSchema.parse(value)); }
export function loadConnector(value: string) { return LocalConnectorSchema.parse(JSON.parse(value)); }
