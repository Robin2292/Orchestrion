import { z } from "zod";
import { ToolGrantSetSchema, ToolIdentitySchema } from "../web-compat/lib/schemas/tool-grants";
import { LocalContextSchema, LocalIdSchema, LocalToolAnchorSchema, LocalHashSchema } from "./local-contracts";
export * from "../web-compat/lib/schemas/tool-grants";

/** Existing registry contract anchor plus Source provenance. Only trusted host
 * composition registers these; discovery/IPC/import cannot manufacture one. */
export const LocalToolContractVersionSchema = z.object({
  context: LocalContextSchema, tool: ToolIdentitySchema, anchor: LocalToolAnchorSchema,
  schema_hash: LocalHashSchema, contract_json: z.string().min(2).max(1048576),
}).strict().refine(v => v.context.org_id === v.anchor.org_id);
export type LocalToolContractVersion = z.infer<typeof LocalToolContractVersionSchema>;

/** Local currently has no Workflow engine. This is an immutable import/draft
 * version seam only; it cannot launch a Workflow or upgrade Agent references. */
export const LocalWorkflowVersionSchema = z.object({
  schema_version: z.literal("orchestrion.local.workflow-version.v1"),
  context: LocalContextSchema, workflow_id: LocalIdSchema, id: LocalIdSchema,
  version_number: z.number().int().positive().safe(), definition_json: z.string().min(2).max(1048576),
  tool_grants: ToolGrantSetSchema.nullable(), tool_grant_ceiling: ToolGrantSetSchema.nullable(),
}).strict();
export type LocalWorkflowVersion = z.infer<typeof LocalWorkflowVersionSchema>;
export function serializeLocalWorkflow(value: LocalWorkflowVersion) { return JSON.stringify(LocalWorkflowVersionSchema.parse(value)); }
export function loadLocalWorkflow(value: string) { return LocalWorkflowVersionSchema.parse(JSON.parse(value)); }
