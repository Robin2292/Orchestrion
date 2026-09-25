import { z } from "zod";
import { LocalContextSchema, LocalHashSchema, LocalIdSchema, LocalRevisionSchema, RuntimeOwnerSchema } from "./local-contracts";
import { ExecutionPlacementBindingSchema, type ExecutionPlacementKind } from "./execution-placement-contracts";

export const ExecutionAttemptLifecycleSchema = z.enum(["bound", "active", "completed", "failed", "cancelled", "requires_rebind"]);
export type ExecutionAttemptLifecycle = z.infer<typeof ExecutionAttemptLifecycleSchema>;

/** Closed lifecycle graph, mirrored by the SQLite transition trigger. A stale or
 * re-placed attempt is never revived: rebinding always creates a new attempt identity. */
export const EXECUTION_ATTEMPT_TRANSITIONS: Readonly<Record<ExecutionAttemptLifecycle, readonly ExecutionAttemptLifecycle[]>> = {
  bound: ["active", "cancelled", "requires_rebind"],
  active: ["completed", "failed", "cancelled", "requires_rebind"],
  requires_rebind: ["cancelled"],
  completed: [], failed: [], cancelled: [],
};
export const RESOLVABLE_LIFECYCLES: readonly ExecutionAttemptLifecycle[] = ["bound", "active"];
/** Storage keeps every frozen contract kind; execution authority is narrower until
 * an isolated/remote/cloud slice proves its own workspace identity and owner model. */
export const EXECUTABLE_PLACEMENTS: readonly ExecutionPlacementKind[] = ["local_trusted"];

const date = z.string().datetime({ offset: true });
const SafeCount = z.number().int().nonnegative().safe();
const CanonicalPath = z.string().min(1).max(32_768).refine((value) => value.trim() === value && !value.includes("\0"));

/** Folder identity captured at bind time from the realpath the host resolved, not caller input. */
export const LocalFolderIdentitySchema = z.object({
  kind: z.literal("local_folder"), canonical_path: CanonicalPath, dev: SafeCount, ino: SafeCount,
}).strict();
export type LocalFolderIdentity = z.infer<typeof LocalFolderIdentitySchema>;
export const WorkspaceIdentitySchema = LocalFolderIdentitySchema.nullable();
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

const binding = {
  session_id: LocalIdSchema, attempt_id: LocalIdSchema, agent_id: LocalIdSchema, agent_version_id: LocalIdSchema,
  placement: ExecutionPlacementBindingSchema, workspace_identity: WorkspaceIdentitySchema,
  owner: RuntimeOwnerSchema, bound_at: date,
};
type BindingShape = { [K in keyof typeof binding]: z.infer<(typeof binding)[K]> };
function consistent(value: BindingShape, context: z.RefinementCtx): void {
  if (value.placement.task_id !== value.session_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["session_id"], message: "session does not match placement task" });
  if (value.placement.attempt_id !== value.attempt_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["attempt_id"], message: "attempt does not match placement attempt" });
  if ((value.placement.placement === "local_trusted") !== (value.workspace_identity !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspace_identity"], message: "folder identity is required exactly for local_trusted" });
  }
  if (value.owner.engine !== "local") context.addIssue({ code: z.ZodIssueCode.custom, path: ["owner"], message: "only the local engine binds attempts" });
}
export const ExecutionAttemptBindInputSchema = z.object(binding).strict().superRefine(consistent);
export type ExecutionAttemptBindInput = z.infer<typeof ExecutionAttemptBindInputSchema>;

export const ExecutionAttemptSchema = z.object({
  context: LocalContextSchema, ...binding, binding_hash: LocalHashSchema,
  lifecycle: ExecutionAttemptLifecycleSchema, revision: LocalRevisionSchema, updated_at: date,
}).strict().superRefine((value, context) => {
  consistent(value, context);
  if (value.placement.project_id !== value.context.project_id) context.addIssue({ code: z.ZodIssueCode.custom, path: ["placement", "project_id"], message: "placement project does not match scope" });
});
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;

export const ExecutionAuthorityRequestSchema = z.object({ sessionId: LocalIdSchema, attemptId: LocalIdSchema }).strict();
export type ExecutionAuthorityRequest = z.infer<typeof ExecutionAuthorityRequestSchema>;

/** Every refusal is a closed code. No path, exception text or stored payload is echoed. */
export const ExecutionAuthorityRefusalCodeSchema = z.enum([
  "EXECUTION_REQUEST_INVALID",
  "EXECUTION_SESSION_NOT_FOUND",
  "EXECUTION_AGENT_NOT_FOUND",
  "EXECUTION_PROJECT_NOT_FOUND",
  "EXECUTION_ATTEMPT_NOT_FOUND",
  "EXECUTION_PROJECT_MISMATCH",
  "EXECUTION_AGENT_MISMATCH",
  "EXECUTION_AGENT_VERSION_MISSING",
  "EXECUTION_BINDING_INVALID",
  "EXECUTION_PLACEMENT_UNSUPPORTED",
  "EXECUTION_REBIND_REQUIRED",
  "EXECUTION_ATTEMPT_FINISHED",
  "EXECUTION_OWNER_STALE",
  "EXECUTION_WORKSPACE_DRIFT",
  "EXECUTION_STATE_CHANGED",
]);
export type ExecutionAuthorityRefusalCode = z.infer<typeof ExecutionAuthorityRefusalCodeSchema>;
export interface ExecutionAuthorityRefusal { ok: false; code: ExecutionAuthorityRefusalCode }
export function executionRefusal(code: ExecutionAuthorityRefusalCode): ExecutionAuthorityRefusal {
  return { ok: false, code: ExecutionAuthorityRefusalCodeSchema.parse(code) };
}
