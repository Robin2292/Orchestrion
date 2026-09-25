import { LocalAssignmentUiRequestSchema } from "../shared/assignment-ui-contracts";
import type { CatalogAgentVersionSchema } from "../shared/assignment-ui-contracts";
import type { z } from "zod";

type Version = z.infer<typeof CatalogAgentVersionSchema>;
type Configure = Extract<z.infer<typeof LocalAssignmentUiRequestSchema>, { operation: "configure" }>;
export type BudgetDraft = { modelTokens: string; toolCalls: string; costUsd: string };

// The checksum of serializeToolGrants({schema_version:"tool_grants@1",grants:[]}).
// This is a requested empty ceiling, never a renderer authority decision; the host
// recomputes and intersects it with live organization and Agent Principal bounds.
export const EMPTY_DIRECT_GRANTS_HASH = "sha256:8452c85e159faa4f656e8867d7c2b1af7cf4a66c1e633509a4ae2a646f4e7bbc";

export function versionCanBeConfigured(version: Version): boolean {
  return version.definition.nodeType === "agent" && version.definition.toolGrants !== null &&
    version.definition.toolGrants !== undefined;
}

export function budgetDraftFromCurrent(current?: { budgetCeilings: {
  modelTokens: number | null; toolCalls: number | null; costUsd: number | null;
} } | null): BudgetDraft {
  return {
    modelTokens: String(current?.budgetCeilings.modelTokens ?? 1000),
    toolCalls: String(current?.budgetCeilings.toolCalls ?? 1),
    costUsd: String(current?.budgetCeilings.costUsd ?? 0),
  };
}

export function configurationForProject(projectId: string, draft: BudgetDraft,
  principalVersionIds: string[] = []): Configure["payload"]["config"] | null {
  const modelTokens = Number(draft.modelTokens);
  const toolCalls = Number(draft.toolCalls);
  const costUsd = Number(draft.costUsd);
  if (!Number.isSafeInteger(modelTokens) || modelTokens < 1 ||
      !Number.isSafeInteger(toolCalls) || toolCalls < 1 ||
      !Number.isFinite(costUsd) || costUsd < 0 ||
      !draft.modelTokens.trim() || !draft.toolCalls.trim() || !draft.costUsd.trim() ||
      principalVersionIds.length > 32 || new Set(principalVersionIds).size !== principalVersionIds.length) return null;
  const ceiling = EMPTY_DIRECT_GRANTS_HASH;
  return {
    parameterValues: {}, connectionBindings: [], credentialReferences: [],
    workspaceScope: { mode: "none", pathPrefixes: [] }, policyReferences: [],
    dataScope: { domains: [], resourceReferences: [] },
    authorityCeiling: { organizationCeilingHash: ceiling, principalGrantHash: ceiling,
      agentVersionGrantHash: ceiling, directGrantVersionIds: principalVersionIds },
    memoryScopeCeiling: { projectId, allowedWorkflowIds: [], allowedDataDomains: [],
      projectPromotionAllowed: false, organizationPromotionAllowed: false },
    placementConstraints: { allowed: ["local_trusted"], fallback: "forbidden" },
    budgetCeilings: { modelTokens, toolCalls, costUsd },
  };
}
