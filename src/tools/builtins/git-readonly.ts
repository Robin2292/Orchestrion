import { exactPath } from "../../shared/policy/p0-canonical";
import type { LocalContext } from "../../shared/local-contracts";
import type { ToolDefinition, ToolParameterSchema } from "../../shared/tool-registry-contracts";
import type { ToolPlannerInput } from "../../shared/tool-invocation-contracts";
import {
  GOVERNED_GIT_CONNECTION, GOVERNED_GIT_CONNECTOR, GOVERNED_GIT_DIFF_TOOL, GOVERNED_GIT_LOG_TOOL,
  GOVERNED_GIT_STATUS_TOOL, GOVERNED_LOGICAL_WORKSPACE_ROOT, GOVERNED_TOOL_REASONS, GitDiffArgumentsSchema,
  GitLogArgumentsSchema, GitStatusArgumentsSchema, gitToolContract,
} from "../../shared/governed-tool-contracts";
import { sensitivePathReason } from "./file-read";
import type { ToolImplementation } from "../registry";

export type GovernedGitTool = typeof GOVERNED_GIT_STATUS_TOOL | typeof GOVERNED_GIT_DIFF_TOOL | typeof GOVERNED_GIT_LOG_TOOL;

export type NormalizedGitPath = { ok: true; relative: string; segments: string[]; logical: string } | { ok: false; code: string };

/** Git pathspecs are a language of their own. v1 accepts only the bounded ASCII
 * subset that P0 can preserve as an exact logical path. `--literal-pathspecs`
 * remains mandatory defense in depth; an unrepresentable filename is refused,
 * never widened to the workspace-root claim. */
export function normalizeGitPath(raw: unknown): NormalizedGitPath {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return { ok: false, code: GOVERNED_TOOL_REASONS.gitPathInvalid };
  if (/[\u0000-\u001f\u007f]/.test(raw) || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~"))
    return { ok: false, code: GOVERNED_TOOL_REASONS.gitPathInvalid };
  const parts = raw.split("/");
  while (parts[0] === ".") parts.shift();
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.length > 255))
    return { ok: false, code: GOVERNED_TOOL_REASONS.gitPathInvalid };
  const sensitive = sensitivePathReason(parts);
  if (sensitive) return { ok: false, code: GOVERNED_TOOL_REASONS.gitSensitiveOutput };
  const relative = parts.join("/");
  const candidate = `${GOVERNED_LOGICAL_WORKSPACE_ROOT}/${relative}`;
  if (!parts.every((part) => /^[A-Za-z0-9._@+!-]+$/.test(part)) || !exactPath(candidate))
    return { ok: false, code: GOVERNED_TOOL_REASONS.gitPathInvalid };
  return { ok: true, relative, segments: parts, logical: candidate };
}

export function normalizeGitRevision(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255 || raw.startsWith("-") || raw.includes("\0")
    || raw.includes(":") || raw.includes("..") || /[\s\\*?\[\]{}^~]/.test(raw)) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(raw) ? raw : null;
}

export type NormalizedGitInvocation =
  | { ok: true; tool: typeof GOVERNED_GIT_STATUS_TOOL; arguments: Record<string, never>; logicalPath: string }
  | { ok: true; tool: typeof GOVERNED_GIT_DIFF_TOOL; arguments: { path: string; cached: boolean; revision?: string }; logicalPath: string }
  | { ok: true; tool: typeof GOVERNED_GIT_LOG_TOOL; arguments: { max_count: number; format: "oneline" | "detailed" }; logicalPath: string }
  | { ok: false; code: string };

export function normalizeGitInvocation(tool: GovernedGitTool, raw: unknown): NormalizedGitInvocation {
  if (tool === GOVERNED_GIT_STATUS_TOOL) {
    if (!GitStatusArgumentsSchema.safeParse(raw).success) return { ok: false, code: GOVERNED_TOOL_REASONS.gitArgumentsInvalid };
    return { ok: true, tool, arguments: {}, logicalPath: GOVERNED_LOGICAL_WORKSPACE_ROOT };
  }
  if (tool === GOVERNED_GIT_DIFF_TOOL) {
    const parsed = GitDiffArgumentsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: GOVERNED_TOOL_REASONS.gitArgumentsInvalid };
    const path = normalizeGitPath(parsed.data.path);
    if (!path.ok) return path;
    const revision = normalizeGitRevision(parsed.data.revision);
    if (parsed.data.revision !== undefined && revision === null) return { ok: false, code: GOVERNED_TOOL_REASONS.gitRevisionInvalid };
    if (parsed.data.cached === true && revision !== null) return { ok: false, code: GOVERNED_TOOL_REASONS.gitArgumentsInvalid };
    return { ok: true, tool, arguments: { path: path.relative, cached: parsed.data.cached ?? false, ...(revision ? { revision } : {}) }, logicalPath: path.logical };
  }
  const parsed = GitLogArgumentsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: GOVERNED_TOOL_REASONS.gitArgumentsInvalid };
  return { ok: true, tool, arguments: { max_count: parsed.data.max_count ?? 20, format: parsed.data.format ?? "oneline" }, logicalPath: GOVERNED_LOGICAL_WORKSPACE_ROOT };
}

function planner(tool: GovernedGitTool, input: ToolPlannerInput) {
  const normalized = normalizeGitInvocation(tool, input.arguments);
  if (!normalized.ok) throw new Error(normalized.code);
  return { arguments: normalized.arguments, claims: [{ type: "workspace_path" as const, value: normalized.logicalPath, mode: "read" as const }] };
}

export function gitDefinition(context: LocalContext, sourceId: string, tool: GovernedGitTool): ToolDefinition {
  const contract = gitToolContract(tool);
  return {
    context: structuredClone(context), sourceId, connectorId: GOVERNED_GIT_CONNECTOR, connectionId: GOVERNED_GIT_CONNECTION,
    name: tool, description: contract.description, parameters: structuredClone(contract.parameters), outputSchema: null,
    implementationId: contract.implementation.id, implementationVersion: contract.implementation.version, policyMode: "external",
  };
}

export function gitImplementation(context: LocalContext, sourceId: string, tool: GovernedGitTool,
  adapter: ToolImplementation["adapter"]): ToolImplementation {
  const definition = gitDefinition(context, sourceId, tool);
  return {
    describe: () => structuredClone(definition), planner: (input: ToolPlannerInput) => planner(tool, input), adapter,
    planningReview: { version: "git-readonly-plan-v1", effect: "read_only", resourceKind: "logical_workspace_path" },
  };
}

export function gitParameters(tool: GovernedGitTool): ToolParameterSchema { return structuredClone(gitToolContract(tool).parameters); }
