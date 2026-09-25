import { z } from "zod";
import { AgentReferenceSchema } from "./agent-contracts";
import { LocalContextSchema, RuntimeOwnerSchema } from "./local-contracts";

export const PROVIDER_CALL_VERSION = "orchestrion.local.provider-call.v1" as const;
export const ProviderSourceSchema = z.enum(["web_provider_adapter", "codex_native"]);
export const ProviderCoverageSchema = z.object({
  source: ProviderSourceSchema,
  toolExecution: z.literal("outside_governed_tool_execution"),
  admittedTools: z.tuple([]),
  accounting: z.literal("not_durable_provider_accounting"),
  evidence: z.enum(["f0-native-command-exec", "a3-local-http-fixture"]),
}).strict();
export type ProviderCoverage = z.infer<typeof ProviderCoverageSchema>;
/** Native notifications/approval callbacks do not prove T2 interception. Never
 * infer Tool inventory or admission from a harness transcript or model list. */
export function nativeProviderCoverage(): ProviderCoverage {
  return ProviderCoverageSchema.parse({ source: "codex_native", toolExecution: "outside_governed_tool_execution",
    admittedTools: [], accounting: "not_durable_provider_accounting", evidence: "f0-native-command-exec" });
}
export const ProviderCallRequestSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CALL_VERSION), context: LocalContextSchema, runtimeOwner: RuntimeOwnerSchema,
  source: ProviderSourceSchema, agent: AgentReferenceSchema,
  // A single already-rendered user message, not an Agent loop/template renderer.
  text: z.string().min(1).max(32768), mode: z.enum(["text", "tools", "code_mode"]),
}).strict();
export type ProviderCallRequest = z.infer<typeof ProviderCallRequestSchema>;
export const ProviderReadinessCodeSchema = z.enum([
  "INVALID_PAYLOAD", "CONTEXT_MISMATCH", "RUNTIME_OWNER_MISMATCH", "AGENT_VERSION_NOT_READY",
  "SOURCE_NOT_READY", "PROVIDER_NOT_READY", "MODEL_NOT_READY", "TOOL_MODE_NOT_READY",
  "REQUEST_MODE_NOT_READY", "CREDENTIAL_NOT_READY", "PROVIDER_BUSY", "PROVIDER_CANCELLED",
  "PROVIDER_TIMEOUT", "PROVIDER_STREAM_LIMIT", "PROVIDER_PROTOCOL_ERROR", "PROVIDER_INCOMPLETE",
  "PROVIDER_RATE_LIMIT", "PROVIDER_UNAVAILABLE", "PROVIDER_NETWORK", "PROVIDER_QUOTA",
  "PROVIDER_AUTH_EXPIRED", "PROVIDER_BAD_REQUEST", "PROVIDER_NOT_FOUND",
]);
export type ProviderReadinessCode = z.infer<typeof ProviderReadinessCodeSchema>;
export const ProviderCallEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("coverage"), coverage: ProviderCoverageSchema }).strict(),
  z.object({ type: z.literal("text"), text: z.string().max(32768) }).strict(),
  z.object({ type: z.literal("completed") }).strict(),
  z.object({ type: z.literal("not_ready"), code: ProviderReadinessCodeSchema, retryable: z.literal(false) }).strict(),
]);
export type ProviderCallEvent = z.infer<typeof ProviderCallEventSchema>;
export function serializeProviderEvent(event: ProviderCallEvent): string { return JSON.stringify(ProviderCallEventSchema.parse(event)); }
export function loadProviderEvent(wire: string): ProviderCallEvent { return ProviderCallEventSchema.parse(JSON.parse(wire)); }

/** Strict allowlist projection of Web StreamChunk. No raw_response, response_id,
 * continuation, credential reference, usage/cost authority or exception text. */
export const ProviderChunkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), text: z.string().max(32768) }).strict(),
  z.object({ type: z.literal("tool_call_start") }).strict(),
  z.object({ type: z.literal("tool_call_delta") }).strict(),
  z.object({ type: z.literal("done"), outcome: z.enum(["completed", "incomplete", "tools"]) }).strict(),
  z.object({ type: z.literal("error"), code: ProviderReadinessCodeSchema }).strict(),
]);
export type ProviderChunk = z.infer<typeof ProviderChunkSchema>;
