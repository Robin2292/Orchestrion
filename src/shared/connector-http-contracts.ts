import { z } from "zod";

export const ConnectorHttpCodeSchema = z.enum(["CONNECTOR_HTTP_DENIED", "CONNECTOR_HTTP_FAILED",
  "CONNECTOR_HTTP_TIMEOUT", "CONNECTOR_AUTH_FAILED", "CONNECTOR_AUTH_STATE_INVALID",
  "CONNECTOR_DISCOVERY_INVALID", "CONNECTOR_STALE", "CONNECTOR_BUSY", "CONNECTOR_DISCONNECTED"]);
export type ConnectorHttpCode = z.infer<typeof ConnectorHttpCodeSchema>;
export const ConnectorHttpFailureSchema = z.object({ ok:z.literal(false),error:z.object({
  code:ConnectorHttpCodeSchema,retryable:z.literal(false) }).strict() }).strict();
export const ConnectorCandidateSchema = z.object({ name:z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  inputSchema:z.record(z.unknown()), outputSchema:z.record(z.unknown()).nullable() }).strict();
/** Candidates are untrusted host data, never registry entries or model tools. */
export const ConnectorHttpProjectionSchema = z.object({ id:z.string().uuid(), revision:z.number().int().nonnegative(),
  status:z.enum(["stale", "discovering", "candidate", "disconnected", "failed"]),
  reason:ConnectorHttpCodeSchema.nullable(), readiness:z.literal("not_ready"), authority:z.literal("none"),
  executableCount:z.literal(0), tools:z.array(ConnectorCandidateSchema).max(256) }).strict();
export type ConnectorHttpProjection = z.infer<typeof ConnectorHttpProjectionSchema>;
export const ConnectorDisconnectSchema = ConnectorHttpProjectionSchema.extend({
  remoteRevocation:z.enum(["confirmed","unconfirmed","not_applicable"]) }).strict();
