import { z } from "zod";
import { LocalContextSchema, LocalIdSchema, LocalHashSchema, LocalToolAnchorSchema } from "./local-contracts";
import { ToolScopeSchema } from "./tool-scope";

/** Deliberately bounded Local schema profile. Unsupported keywords fail closed. */
export interface ToolParameterSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolParameterSchema;
  enum?: (string | number | boolean | null)[];
}
export const ToolParameterSchemaSchema: z.ZodType<ToolParameterSchema> = z.lazy(() => z.object({
  type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]),
  description: z.string().max(8192).optional(),
  properties: z.record(ToolParameterSchemaSchema).optional(),
  required: z.array(LocalIdSchema).max(512).optional(),
  additionalProperties: z.boolean().optional(),
  items: ToolParameterSchemaSchema.optional(),
  enum: z.array(z.union([z.string(), z.number().int().safe(), z.boolean(), z.null()])).min(1).max(512).optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.type !== "object" && (v.properties || v.required || v.additionalProperties !== undefined))
      || (v.type === "array" ? !v.items : !!v.items)
      || (v.required && (new Set(v.required).size !== v.required.length || v.required.some((k) => !Object.hasOwn(v.properties ?? {}, k)))))
    ctx.addIssue({ code: "custom", message: "TOOL_SCHEMA_INVALID" });
  if (v.enum?.some((x) => !(v.type === "null" ? x === null : v.type === "integer" ? typeof x === "number" && Number.isInteger(x) : typeof x === v.type)))
    ctx.addIssue({ code: "custom", message: "TOOL_SCHEMA_INVALID" });
}));
export const ToolDefinitionSchema = z.object({
  context: LocalContextSchema,
  sourceId: LocalIdSchema,
  connectorId: LocalIdSchema,
  connectionId: LocalIdSchema,
  name: LocalIdSchema,
  description: z.string().max(8192),
  parameters: ToolParameterSchemaSchema.refine((s) => s.type === "object"),
  outputSchema: ToolParameterSchemaSchema.nullable(),
  implementationId: LocalIdSchema,
  implementationVersion: LocalIdSchema,
  policyMode: z.literal("external"),
}).strict();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
/** Data contract only; no result can be used as a grant or execution receipt. */
export const ToolResultSchema = z.object({
  success: z.boolean(), data: z.unknown(), error: z.string().nullable(), summary: z.string().nullable(),
  outcome: z.enum(["success", "partial", "failure"]), errorCode: z.string().nullable(),
  errorCategory: z.string().nullable(), retryMode: z.enum(["never", "same_args_after_backoff", "model_must_change_args", "unknown_side_effect_do_not_replay"]),
}).strict().refine((v) => v.success === (v.outcome === "success"));
export type ToolResult = z.infer<typeof ToolResultSchema>;
/** Completeness witness supplied by the trusted policy owner, never a decision. */
export const ToolPolicyMetadataSchema = z.object({
  context: LocalContextSchema, anchor: LocalToolAnchorSchema, scope: ToolScopeSchema,
  policyRevision: LocalIdSchema, complete: z.literal(true), evaluationJson: z.string().max(128 * 1024),
}).strict();
export type ToolPolicyMetadata = z.infer<typeof ToolPolicyMetadataSchema>;
export const ModelToolSchema = z.object({ type: z.literal("function"), function: z.object({
  name: z.string().regex(/^t_[0-9a-f]{60}$/), description: z.string().max(8192), parameters: ToolParameterSchemaSchema,
}).strict() }).strict();
export const ToolInventoryEntrySchema = z.object({ anchor: LocalToolAnchorSchema, connectorId: LocalIdSchema,
  connectionId: LocalIdSchema, sourceId: LocalIdSchema, scope: ToolScopeSchema,
  policyRevision: LocalIdSchema, policyHash: LocalHashSchema,
  policyPreview: z.enum(["allow", "require_approval"]), model: ModelToolSchema }).strict();
export const ToolInventorySchema = z.object({ schemaVersion: z.literal("orchestrion.local.tool-inventory.v1"),
  authority: z.literal("none"), context: LocalContextSchema, agentId: LocalIdSchema, versionId: LocalIdSchema,
  entries: z.array(ToolInventoryEntrySchema).max(65536), digest: LocalHashSchema }).strict();
export type ToolInventory = z.infer<typeof ToolInventorySchema>;
