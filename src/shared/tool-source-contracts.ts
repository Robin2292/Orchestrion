import { z } from "zod";
import { LocalContextSchema } from "./local-contracts";
import { ToolParameterSchemaSchema } from "./tool-registry-contracts";

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const State = z.enum(["accepted", "rejected", "quarantined", "unsupported", "needs_setup"]);

export const LocalSourceDiscoverySchema = z.object({
  context: LocalContextSchema,
  kind: z.enum(["mcp", "http", "database"]),
  namespace: z.string().min(1).max(255),
  label: z.string().min(1).max(255),
  connection: z.object({ id: z.string().min(1).max(255), authorityHash: Digest }).strict().nullable(),
  state: State,
  reasonCode: z.string().min(1).max(128),
  credentialReadiness: z.enum(["not_required", "ready", "missing", "revoked", "unknown"]),
  contentDigest: Digest.nullable(),
  acceptedContentDigest: Digest.nullable(),
  tools: z.array(z.object({
    key: z.string().min(1).max(255), name: z.string().min(1).max(255),
    description: z.string().max(8192), inputSchema: ToolParameterSchemaSchema,
    outputSchema: ToolParameterSchemaSchema.nullable(), annotations: z.record(z.unknown()),
  }).strict()).max(256),
}).strict();
export type LocalSourceDiscovery = z.infer<typeof LocalSourceDiscoverySchema>;

const IdentityPart = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const Selection = z.object({
  connection: z.object({
    kind: z.enum(["mcp_server", "database", "local_connector"]),
    id: z.string().min(1).max(255), authorityHash: Digest,
  }).strict().nullable(),
  executionTarget: z.object({
    kind: z.enum(["local_workspace", "runner"]), id: z.string().min(1).max(255),
    placement: z.enum(["local_trusted", "local_isolated", "remote_self_hosted", "managed_cloud"]),
    workspaceHash: Digest,
  }).strict().nullable(),
}).strict().superRefine((value, issue) => {
  if ((value.connection === null) === (value.executionTarget === null))
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one Source selection target is required" });
  if (value.executionTarget?.kind === "local_workspace" && value.executionTarget.placement !== "local_trusted")
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "local workspace targets require local_trusted placement" });
  if (value.executionTarget?.kind === "runner" && value.executionTarget.placement !== "remote_self_hosted")
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "runner targets require remote_self_hosted placement" });
});
const Drift = z.object({
  content: z.boolean(), schema: z.boolean(), executor: z.boolean(), contract: z.boolean(),
  requiresReview: z.boolean(), requiresPublish: z.boolean(),
}).strict();
const Review = z.object({
  latestSnapshotId: z.string().nullable(), acceptedSnapshotId: z.string().nullable(),
  acceptedContentDigest: Digest.nullable(), latestContentDigest: Digest.nullable(),
  publishedRevision: z.number().int().positive().nullable(), activeRevision: z.number().int().positive().nullable(),
  rollbackRevision: z.number().int().positive().nullable(),
}).strict();
const Metadata = z.object({
  name: z.string().min(1).max(255), description: z.string().max(8192), namespace: z.string().min(1).max(255),
  inputSchema: z.record(z.unknown()), outputSchema: z.record(z.unknown()).nullable(),
  claimedEffects: z.array(z.enum(["read", "write", "delete", "execute"])).max(4),
  claimedRisk: z.enum(["low", "medium", "high", "unknown"]), annotations: z.record(z.unknown()),
  trust: z.enum(["reviewed", "untrusted"]), metadataDigest: Digest,
}).strict();
const Contract = z.object({
  versionId: z.string().min(1).max(255), contractHash: Digest, schemaHash: Digest, executorHash: Digest,
  declaredEffects: z.array(z.enum(["read", "write", "delete", "execute"])).min(1).max(4),
  physicalReadonlyProven: z.boolean(),
}).strict();
const Tool = z.object({
  catalogId: Digest, identity: z.object({ source: IdentityPart, key: IdentityPart }).strict().nullable(),
  selection: Selection.nullable(), metadata: Metadata, state: State,
  reasonCode: z.string().min(1).max(128), authority: z.literal("none"), contract: Contract.nullable(),
  drift: Drift, grantReadiness: z.enum(["ready", "needs_review", "needs_publish", "unsupported", "needs_setup"]),
}).strict();
const Connection = z.object({
  selection: Selection.nullable(), label: z.string().min(1).max(255), state: State,
  reasonCode: z.string().min(1).max(128),
  credentialReadiness: z.enum(["not_required", "ready", "missing", "revoked", "unknown"]),
  review: Review, drift: Drift, tools: z.array(Tool).max(1024),
}).strict();
export const LocalToolSourceCatalogSchema = z.object({
  schemaVersion: z.literal("tool_source_catalog@1"), authority: z.literal("none"),
  orgId: z.string().min(1).max(255),
  sources: z.array(z.object({
    namespace: z.string().min(1).max(255), kind: z.enum(["builtin", "mcp", "http", "database"]),
    label: z.string().min(1).max(255), authority: z.literal("none"), connections: z.array(Connection).max(1024),
  }).strict()).max(1024),
}).strict();
export type LocalToolSourceCatalog = z.infer<typeof LocalToolSourceCatalogSchema>;

/** Reviewed discovery metadata only; never a grant, registry row or callable. */
export const LocalReviewedToolDescriptorSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(8192),
  connectorId: z.string().min(1).max(255),
  connectionId: z.string().min(1).max(255),
  parameters: ToolParameterSchemaSchema,
  outputSchema: ToolParameterSchemaSchema.nullable(),
  implementationId: z.string().min(1).max(255),
  implementationVersion: z.string().min(1).max(255),
  contractHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  source: z.literal("reviewed_builtin"),
  authority: z.literal("none"),
}).strict();
export type LocalReviewedToolDescriptor = z.infer<typeof LocalReviewedToolDescriptorSchema>;
