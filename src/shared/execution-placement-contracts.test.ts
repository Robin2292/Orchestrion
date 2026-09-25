import { describe, expect, it } from "vitest";
import {
  EXECUTION_PLACEMENT_CONTRACT_VERSION,
  ExecutionPlacementBindingSchema,
  ExecutionPlacementKindSchema,
  ExecutionPlacementNormalizationSchema,
  ReservedWorkspaceSnapshotKindSchema,
  WorkspaceRefSchema,
  normalizeExecutionPlacement,
} from "./execution-placement-contracts";

const localFolder = { kind: "local_folder" as const, path: "/Users/example/project" };
const mountedFolder = { kind: "mounted_folder" as const, source_path: "C:\\work\\project", mount_path: "/workspace" };
const repository = {
  kind: "repository_ref" as const,
  repository: "git@github.com:example/project.git",
  revision: "0123456789abcdef",
  subdirectory: null,
};

function binding(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: EXECUTION_PLACEMENT_CONTRACT_VERSION,
    project_id: "project-1",
    task_id: "task-1",
    attempt_id: "attempt-1",
    placement: "local_trusted",
    workspace: localFolder,
    selected_by: "user",
    fallback: "forbidden",
    frozen: true,
    disclosure: "current_host_user_not_os_sandboxed",
    reason_code: "USER_SELECTED_PLACEMENT",
    ...overrides,
  };
}

describe("EP-0 execution placement contract", () => {
  it("freezes the four OS-neutral placement names", () => {
    expect(ExecutionPlacementKindSchema.options).toEqual([
      "local_trusted",
      "local_isolated",
      "remote_self_hosted",
      "managed_cloud",
    ]);
  });

  it("accepts local, mounted and pinned repository workspaces but reserves snapshots", () => {
    expect(WorkspaceRefSchema.parse(localFolder)).toEqual(localFolder);
    expect(WorkspaceRefSchema.parse(mountedFolder)).toEqual(mountedFolder);
    expect(WorkspaceRefSchema.parse(repository)).toEqual(repository);
    expect(ReservedWorkspaceSnapshotKindSchema.parse("workspace_snapshot")).toBe("workspace_snapshot");
    expect(() => WorkspaceRefSchema.parse({ kind: "workspace_snapshot", snapshot_id: "future" })).toThrow();
    expect(() => WorkspaceRefSchema.parse({ ...localFolder, projectPath: "/forged" })).toThrow();
  });

  it("binds placement to one task attempt with exact disclosure and no fallback", () => {
    expect(ExecutionPlacementBindingSchema.parse(binding())).toEqual(binding());
    expect(ExecutionPlacementBindingSchema.parse(binding({
      placement: "local_isolated",
      workspace: mountedFolder,
      selected_by: "policy",
      disclosure: "local_container_isolation",
      reason_code: "POLICY_REQUIRED_PLACEMENT",
    })).placement).toBe("local_isolated");
    expect(ExecutionPlacementBindingSchema.parse(binding({
      placement: "remote_self_hosted",
      workspace: repository,
      disclosure: "remote_operator_managed",
    })).placement).toBe("remote_self_hosted");
    expect(ExecutionPlacementBindingSchema.parse(binding({
      placement: "managed_cloud",
      workspace: repository,
      disclosure: "managed_cloud_repository_checkout",
    })).placement).toBe("managed_cloud");
  });

  it.each([
    { fallback: "host" },
    { frozen: false },
    { workspace: repository },
    { disclosure: "local_container_isolation" },
    { selected_by: "policy", reason_code: "USER_SELECTED_PLACEMENT" },
  ])("rejects drift or silent fallback: %o", (change) => {
    expect(() => ExecutionPlacementBindingSchema.parse(binding(change))).toThrow();
  });

  it.each([
    "local_trusted",
    "local_isolated",
    "remote_self_hosted",
    "managed_cloud",
  ] as const)("normalizes canonical %s without changing it", (placement) => {
    const normalized = normalizeExecutionPlacement(placement);
    expect(ExecutionPlacementNormalizationSchema.parse(normalized)).toEqual(normalized);
    expect(normalized).toEqual({
      status: "ready",
      placement,
      source: "canonical",
      legacy_ref: null,
      reason_code: "EXECUTION_PLACEMENT_CANONICAL",
    });
  });

  it.each([
    ["local_logical", "local_trusted"],
    ["local_filesystem", "local_trusted"],
    ["sandbox", "local_isolated"],
    ["runner", "remote_self_hosted"],
    ["local:runner-42", "remote_self_hosted"],
  ] as const)("classifies legacy %s as %s but requires an explicit rebind", (legacy, placement) => {
    const normalized = normalizeExecutionPlacement(legacy);
    expect(ExecutionPlacementNormalizationSchema.parse(normalized)).toEqual(normalized);
    expect(normalized).toEqual({
      status: "requires_rebind",
      placement,
      source: "legacy",
      legacy_ref: legacy,
      reason_code: "EXECUTION_PLACEMENT_LEGACY_REBIND_REQUIRED",
    });
  });

  it.each(["auto", "local:", "docker", "cloud", null, { kind: "local_trusted" }])(
    "rejects unsupported input without inventing a fallback: %o",
    (input) => {
      const normalized = normalizeExecutionPlacement(input);
      expect(ExecutionPlacementNormalizationSchema.parse(normalized)).toEqual(normalized);
      expect(normalized).toEqual({
        status: "rejected",
        placement: null,
        source: "unsupported",
        legacy_ref: null,
        reason_code: "EXECUTION_PLACEMENT_UNSUPPORTED",
      });
    },
  );
});
