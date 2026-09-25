import { z } from "zod";
import { LocalContextSchema, LocalHashSchema, LocalRevisionSchema } from "./local-contracts";
import { ToolParameterSchemaSchema } from "./tool-registry-contracts";

const id = z.string().uuid();
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/);
export const SourcePinSchema = z.object({ connectorId:id, connectorRevision:LocalRevisionSchema,
  configHash:LocalHashSchema, credentialRef:id.nullable(), credentialRevision:LocalRevisionSchema.nullable() }).strict();
export const DiscoveredToolSchema = z.object({ key, inputSchema:ToolParameterSchemaSchema.refine(v => v.type === "object"),
  outputSchema:ToolParameterSchemaSchema.nullable() }).strict();
/** Host-owned evidence only. Renderer/model input must never be parsed as this proof. */
export const SourceCandidateSchema = z.object({ connectorId:id, connectorRevision:LocalRevisionSchema,
  adapterKind:z.string().min(1).max(64), status:z.literal("candidate"),
  tools:z.array(DiscoveredToolSchema).max(256) }).strict().refine(v => new Set(v.tools.map(t => t.key)).size === v.tools.length);
export type SourceCandidate = z.infer<typeof SourceCandidateSchema>;
export const SourceSnapshotSchema = z.object({ schemaVersion:z.literal("orchestrion.local.source-snapshot.v1"),
  compilerVersion:z.literal("c3a-tool-schema-v1"), id, context:LocalContextSchema, sourceId:id, connectionId:id, pin:SourcePinSchema,
  adapterKind:z.string().min(1).max(64), tools:z.array(DiscoveredToolSchema).max(256),
  contentHash:LocalHashSchema, acceptedAt:z.string().datetime() }).strict()
  .refine(v=>v.sourceId===v.connectionId && v.pin.connectorId===v.sourceId);
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;
export const SourcePublicationSchema = z.object({ schemaVersion:z.literal("orchestrion.local.source-publication.v1"),
  compilerVersion:z.literal("c3a-tool-schema-v1"), id, context:LocalContextSchema, sourceId:id, connectionId:id, version:z.number().int().positive().safe(),
  snapshotId:id, snapshotHash:LocalHashSchema, pin:SourcePinSchema, adapterKind:z.string().min(1).max(64),
  tools:z.array(z.object({ sourceId:id, connectionId:id, key, contractId:key, ownerKey:key,
    contractHash:LocalHashSchema, schemaHash:LocalHashSchema,
    inputSchema:ToolParameterSchemaSchema, outputSchema:ToolParameterSchemaSchema.nullable() }).strict()).max(256),
  publishedAt:z.string().datetime() }).strict()
  .refine(v=>v.sourceId===v.connectionId && v.pin.connectorId===v.sourceId
    && v.tools.every(t=>t.sourceId===v.sourceId && t.connectionId===v.connectionId));
export type SourcePublication = z.infer<typeof SourcePublicationSchema>;
export const SourceIdentitySchema = z.object({ id }).strict();
export const SourceConnectorPinSchema = z.object({ connectorId:id, revision:LocalRevisionSchema }).strict();
export const SourceDraftInputSchema = z.object({ id, snapshotId:id }).strict();
export const SourceReleaseInputSchema = z.object({ id, draftId:id }).strict();
export const SourceActivateInputSchema = z.object({ releaseId:id }).strict();
export const SourceContractPinSchema = z.object({ sourceId:id,contractId:key,contractHash:LocalHashSchema }).strict();
export const SourceReadinessSchema = z.object({ accepted:z.boolean(), published:z.boolean(), connectionReady:z.boolean(),
  executionReady:z.literal(false), activeReleaseId:id.nullable(), reason:z.enum([
    "SOURCE_NOT_ACCEPTED","SOURCE_NOT_PUBLISHED","SOURCE_NOT_ACTIVE","SOURCE_DRIFT","SOURCE_ADAPTER_NOT_READY","SOURCE_EXECUTION_NOT_READY",
  ]) }).strict();
export const SourceRejectionCodeSchema = z.enum(["SOURCE_NOT_FOUND","SOURCE_CORRUPT","SOURCE_DISCOVERY_NOT_READY",
  "SOURCE_DRIFT","SOURCE_DRAFT_NOT_FOUND","SOURCE_DRAFT_FROZEN","SOURCE_REVIEW_REQUIRED",
  "SOURCE_RELEASE_NOT_FOUND","SOURCE_ALREADY_ACTIVE","SOURCE_ROLLBACK_INVALID","SOURCE_VERSION_EXHAUSTED"]);
export function serializeSourcePublication(value: SourcePublication) { return JSON.stringify(SourcePublicationSchema.parse(value)); }
export function loadSourcePublication(value: string) { return SourcePublicationSchema.parse(JSON.parse(value)); }
