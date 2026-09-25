import { z } from "zod";
import { LocalIdSchema } from "./local-contracts";

export const EXECUTION_PLACEMENT_CONTRACT_VERSION = "orchestrion.execution-placement.v1" as const;

export const ExecutionPlacementKindSchema = z.enum([
  "local_trusted",
  "local_isolated",
  "remote_self_hosted",
  "managed_cloud",
]);
export type ExecutionPlacementKind = z.infer<typeof ExecutionPlacementKindSchema>;

const NativePathSchema = z.string().min(1).max(32_768)
  .refine((value) => value.trim() === value && !value.includes("\0"));
const RepositoryLocatorSchema = z.string().min(1).max(4_096)
  .refine((value) => value.trim() === value && !value.includes("\0"));

export const LocalFolderRefSchema = z.object({
  kind: z.literal("local_folder"),
  path: NativePathSchema,
}).strict();
export const MountedFolderRefSchema = z.object({
  kind: z.literal("mounted_folder"),
  source_path: NativePathSchema,
  mount_path: NativePathSchema,
}).strict();
export const RepositoryRefSchema = z.object({
  kind: z.literal("repository_ref"),
  repository: RepositoryLocatorSchema,
  revision: LocalIdSchema,
  subdirectory: NativePathSchema.nullable(),
}).strict();

/** Reserved discriminator only. Snapshot upload is deliberately not accepted by
 * WorkspaceRefSchema until its manifest, secret filtering and retention contract exists. */
export const ReservedWorkspaceSnapshotKindSchema = z.literal("workspace_snapshot");
export const WorkspaceRefSchema = z.discriminatedUnion("kind", [
  LocalFolderRefSchema,
  MountedFolderRefSchema,
  RepositoryRefSchema,
]);
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;

export const ExecutionPlacementDisclosureSchema = z.enum([
  "current_host_user_not_os_sandboxed",
  "local_container_isolation",
  "remote_operator_managed",
  "managed_cloud_repository_checkout",
]);
export const ExecutionPlacementBindingReasonSchema = z.enum([
  "USER_SELECTED_PLACEMENT",
  "POLICY_REQUIRED_PLACEMENT",
]);

const disclosureFor: Record<ExecutionPlacementKind, z.infer<typeof ExecutionPlacementDisclosureSchema>> = {
  local_trusted: "current_host_user_not_os_sandboxed",
  local_isolated: "local_container_isolation",
  remote_self_hosted: "remote_operator_managed",
  managed_cloud: "managed_cloud_repository_checkout",
};

function workspaceAllowed(placement: ExecutionPlacementKind, workspace: WorkspaceRef): boolean {
  if (placement === "local_trusted") return workspace.kind === "local_folder";
  if (placement === "local_isolated") return workspace.kind === "mounted_folder";
  if (placement === "managed_cloud") return workspace.kind === "repository_ref";
  return workspace.kind === "mounted_folder" || workspace.kind === "repository_ref";
}

/** Immutable-by-contract task/attempt binding. Consumers persist or deep-freeze
 * the parsed value; changing placement requires a new attempt identity. */
export const ExecutionPlacementBindingSchema = z.object({
  schema_version: z.literal(EXECUTION_PLACEMENT_CONTRACT_VERSION),
  project_id: LocalIdSchema,
  task_id: LocalIdSchema,
  attempt_id: LocalIdSchema,
  placement: ExecutionPlacementKindSchema,
  workspace: WorkspaceRefSchema,
  selected_by: z.enum(["user", "policy"]),
  fallback: z.literal("forbidden"),
  frozen: z.literal(true),
  disclosure: ExecutionPlacementDisclosureSchema,
  reason_code: ExecutionPlacementBindingReasonSchema,
}).strict().superRefine((value, context) => {
  if (!workspaceAllowed(value.placement, value.workspace)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspace"], message: "workspace is incompatible with placement" });
  }
  if (value.disclosure !== disclosureFor[value.placement]) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["disclosure"], message: "disclosure does not match placement" });
  }
  const expectedReason = value.selected_by === "user" ? "USER_SELECTED_PLACEMENT" : "POLICY_REQUIRED_PLACEMENT";
  if (value.reason_code !== expectedReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason_code"], message: "reason code does not match selector" });
  }
});
export type ExecutionPlacementBinding = z.infer<typeof ExecutionPlacementBindingSchema>;

export const LegacyExecutionPlacementSchema = z.union([
  z.enum(["local_logical", "local_filesystem", "runner", "sandbox"]),
  z.string().max(261).refine((value) =>
    value.startsWith("local:") && LocalIdSchema.safeParse(value.slice("local:".length)).success),
]);
export type LegacyExecutionPlacement = z.infer<typeof LegacyExecutionPlacementSchema>;

export const ExecutionPlacementNormalizationReasonSchema = z.enum([
  "EXECUTION_PLACEMENT_CANONICAL",
  "EXECUTION_PLACEMENT_LEGACY_REBIND_REQUIRED",
  "EXECUTION_PLACEMENT_UNSUPPORTED",
]);
export const ExecutionPlacementNormalizationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    placement: ExecutionPlacementKindSchema,
    source: z.literal("canonical"),
    legacy_ref: z.null(),
    reason_code: z.literal("EXECUTION_PLACEMENT_CANONICAL"),
  }).strict(),
  z.object({
    status: z.literal("requires_rebind"),
    placement: ExecutionPlacementKindSchema,
    source: z.literal("legacy"),
    legacy_ref: LegacyExecutionPlacementSchema,
    reason_code: z.literal("EXECUTION_PLACEMENT_LEGACY_REBIND_REQUIRED"),
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    placement: z.null(),
    source: z.literal("unsupported"),
    legacy_ref: z.null(),
    reason_code: z.literal("EXECUTION_PLACEMENT_UNSUPPORTED"),
  }).strict(),
]);
export type ExecutionPlacementNormalization = z.infer<typeof ExecutionPlacementNormalizationSchema>;

const legacyPlacementMap: Record<"local_logical" | "local_filesystem" | "runner" | "sandbox", ExecutionPlacementKind> = {
  local_logical: "local_trusted",
  local_filesystem: "local_trusted",
  runner: "remote_self_hosted",
  sandbox: "local_isolated",
};

/** Compatibility is classification, not authority. Legacy values always require
 * an explicit new task binding; unsupported input returns a typed, redacted refusal. */
export function normalizeExecutionPlacement(raw: unknown): ExecutionPlacementNormalization {
  const canonical = ExecutionPlacementKindSchema.safeParse(raw);
  if (canonical.success) {
    return {
      status: "ready",
      placement: canonical.data,
      source: "canonical",
      legacy_ref: null,
      reason_code: "EXECUTION_PLACEMENT_CANONICAL",
    };
  }
  const legacy = LegacyExecutionPlacementSchema.safeParse(raw);
  if (!legacy.success) {
    return {
      status: "rejected",
      placement: null,
      source: "unsupported",
      legacy_ref: null,
      reason_code: "EXECUTION_PLACEMENT_UNSUPPORTED",
    };
  }
  const placement = legacy.data.startsWith("local:")
    ? "remote_self_hosted"
    : legacyPlacementMap[legacy.data as keyof typeof legacyPlacementMap];
  return {
    status: "requires_rebind",
    placement,
    source: "legacy",
    legacy_ref: legacy.data,
    reason_code: "EXECUTION_PLACEMENT_LEGACY_REBIND_REQUIRED",
  };
}
