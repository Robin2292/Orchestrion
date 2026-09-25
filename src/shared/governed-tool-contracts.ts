import { z } from "zod";
import { LocalIdSchema } from "./local-contracts";
import type { ToolParameterSchema } from "./tool-registry-contracts";

/** EP1-B: the single governed, read-only built-in offered to a Codex thread.
 * Governed identity (registry, immutable Tool contract, direct grant, Policy releases) is `file.read`.
 * Codex requires dynamic tool names to match ^[a-zA-Z0-9_-]+$ (verified against
 * codex-cli 0.154.0), so the wire name is `file_read`; the mapping lives only at
 * the app-server boundary and never widens which tool is admitted. */
export const GOVERNED_FILE_READ_TOOL = "file.read" as const;
export const GOVERNED_FILE_READ_WIRE_NAME = "file_read" as const;
export const GOVERNED_FILE_READ_CONNECTOR = "orchestrion.builtin.file" as const;
export const GOVERNED_FILE_READ_CONNECTION = "local-workspace" as const;
export const GOVERNED_FILE_READ_IMPLEMENTATION = { id: "orchestrion.builtin.file.read", version: "v1" } as const;
export const GOVERNED_FILE_READ_REVIEW = { version: "file-read-plan-v1", effect: "read_only", resourceKind: "logical_workspace_path" } as const;
export const GOVERNED_GIT_STATUS_TOOL = "git.status" as const;
export const GOVERNED_GIT_DIFF_TOOL = "git.diff" as const;
export const GOVERNED_GIT_LOG_TOOL = "git.log" as const;
export const GOVERNED_GIT_STATUS_WIRE_NAME = "git_status" as const;
export const GOVERNED_GIT_DIFF_WIRE_NAME = "git_diff" as const;
export const GOVERNED_GIT_LOG_WIRE_NAME = "git_log" as const;
export const GOVERNED_GIT_CONNECTOR = "orchestrion.builtin.git" as const;
export const GOVERNED_GIT_CONNECTION = "local-workspace" as const;
export const GOVERNED_GIT_TOOLS = [GOVERNED_GIT_STATUS_TOOL, GOVERNED_GIT_DIFF_TOOL, GOVERNED_GIT_LOG_TOOL] as const;
export const GOVERNED_TOOLS = [GOVERNED_FILE_READ_TOOL, ...GOVERNED_GIT_TOOLS] as const;
export type GovernedToolName = (typeof GOVERNED_TOOLS)[number];
/** Logical root every claim is expressed under; the executor maps it onto the
 * attempt's canonical folder identity, never onto caller-supplied paths. */
export const GOVERNED_LOGICAL_WORKSPACE_ROOT = "/workspace" as const;
export const GOVERNED_FILE_READ_MAX_BYTES = 256 * 1024;
export const GOVERNED_FILE_READ_MAX_PATH_LENGTH = 1024;

export const FILE_READ_PARAMETERS: ToolParameterSchema = {
  type: "object",
  description: "Read one UTF-8 text file inside the session's project folder.",
  properties: {
    path: {
      type: "string",
      description: "File path relative to the project root, using forward slashes (for example src/index.ts). Absolute paths, .., and secret-bearing locations are refused.",
    },
  },
  required: ["path"],
  additionalProperties: false,
};
export const FILE_READ_DESCRIPTION = "Governed read-only access to one UTF-8 text file (at most 256 KiB) inside the current project folder. Pass a path relative to the project root. Secret-bearing files (.env*, credentials, private keys, .git internals) and anything outside the project are always refused.";

export const FileReadArgumentsSchema = z.object({
  path: z.string().min(1).max(GOVERNED_FILE_READ_MAX_PATH_LENGTH),
}).strict();
export type FileReadArguments = z.infer<typeof FileReadArgumentsSchema>;

export const GIT_STATUS_PARAMETERS: ToolParameterSchema = {
  type: "object", description: "No arguments.", properties: {}, required: [], additionalProperties: false,
};
export const GIT_DIFF_PARAMETERS: ToolParameterSchema = {
  type: "object", description: "Show a bounded patch for exactly one workspace-relative file.",
  properties: {
    path: { type: "string", description: "One literal workspace-relative file path. Git pathspec patterns are not expanded." },
    cached: { type: "boolean", description: "Compare the index with HEAD. Cannot be combined with revision." },
    revision: { type: "string", description: "One non-option revision name to compare with the working tree. Ranges are refused." },
  }, required: ["path"], additionalProperties: false,
};
export const GIT_LOG_PARAMETERS: ToolParameterSchema = {
  type: "object", description: "Show bounded commit metadata from HEAD.",
  properties: {
    max_count: { type: "integer", description: "Maximum commits, from 1 through 50." },
    format: { type: "string", enum: ["oneline", "detailed"], description: "Bounded metadata format." },
  }, required: [], additionalProperties: false,
};
export const GitStatusArgumentsSchema = z.object({}).strict();
export const GitDiffArgumentsSchema = z.object({ path: z.string().min(1).max(1024), cached: z.boolean().optional(), revision: z.string().min(1).max(255).optional() }).strict();
export const GitLogArgumentsSchema = z.object({ max_count: z.number().int().min(1).max(50).optional(), format: z.enum(["oneline", "detailed"]).optional() }).strict();

const GIT_CONTRACTS = {
  [GOVERNED_GIT_STATUS_TOOL]: { wire: GOVERNED_GIT_STATUS_WIRE_NAME, description: "Governed read-only Git status for the current project. No shell, repository mutation, credentials or network are available.", parameters: GIT_STATUS_PARAMETERS, implementation: { id: "orchestrion.builtin.git.status", version: "v1" } },
  [GOVERNED_GIT_DIFF_TOOL]: { wire: GOVERNED_GIT_DIFF_WIRE_NAME, description: "Governed bounded Git patch for exactly one non-secret workspace file. Pathspec expansion, external diff and text conversion are disabled.", parameters: GIT_DIFF_PARAMETERS, implementation: { id: "orchestrion.builtin.git.diff", version: "v1" } },
  [GOVERNED_GIT_LOG_TOOL]: { wire: GOVERNED_GIT_LOG_WIRE_NAME, description: "Governed bounded Git commit metadata from HEAD. Revisions, patches, signatures and external helpers are unavailable.", parameters: GIT_LOG_PARAMETERS, implementation: { id: "orchestrion.builtin.git.log", version: "v1" } },
} as const;
export function gitToolContract(tool: typeof GOVERNED_GIT_TOOLS[number]) { return GIT_CONTRACTS[tool]; }
export function governedToolForWire(wire: string): GovernedToolName | null {
  if (wire === GOVERNED_FILE_READ_WIRE_NAME) return GOVERNED_FILE_READ_TOOL;
  for (const tool of GOVERNED_GIT_TOOLS) if (GIT_CONTRACTS[tool].wire === wire) return tool;
  return null;
}

/** Closed refusal vocabulary owned by this vertical. Existing EXECUTION_*, TOOL_*
 * and POLICY_* codes from EP1-A/T2/P1 pass through unchanged. No path, exception
 * text, file content or stored payload ever reaches Codex or the event log. */
export const GovernedToolReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
export const GOVERNED_TOOL_REASONS = {
  notDeclared: "TOOL_CALL_NOT_DECLARED",
  unknownTool: "TOOL_CALL_UNKNOWN_TOOL",
  duplicate: "TOOL_CALL_DUPLICATE",
  cancelled: "TOOL_CALL_CANCELLED",
  staleTurn: "TOOL_CALL_STALE_TURN",
  hostUnavailable: "TOOL_CALL_HOST_UNAVAILABLE",
  readinessLost: "TOOL_CALL_READINESS_LOST",
  timedOut: "TOOL_CALL_TIMED_OUT",
  argumentsInvalid: "FILE_READ_ARGUMENTS_INVALID",
  pathInvalid: "FILE_READ_PATH_INVALID",
  sensitivePath: "FILE_READ_SENSITIVE_PATH",
  symlinkRefused: "FILE_READ_SYMLINK_REFUSED",
  notFound: "FILE_READ_NOT_FOUND",
  notAFile: "FILE_READ_NOT_A_FILE",
  tooLarge: "FILE_READ_TOO_LARGE",
  notUtf8: "FILE_READ_NOT_UTF8",
  workspaceDrift: "FILE_READ_WORKSPACE_DRIFT",
  gitArgumentsInvalid: "GIT_ARGUMENTS_INVALID",
  gitPathInvalid: "GIT_PATH_INVALID",
  gitRevisionInvalid: "GIT_REVISION_INVALID",
  gitRepositoryRefused: "GIT_REPOSITORY_REFUSED",
  gitWorkspaceDrift: "GIT_WORKSPACE_DRIFT",
  gitProcessFailed: "GIT_PROCESS_FAILED",
  gitOutputTooLarge: "GIT_OUTPUT_TOO_LARGE",
  gitOutputNotUtf8: "GIT_OUTPUT_NOT_UTF8",
  gitSensitiveOutput: "GIT_SENSITIVE_OUTPUT",
} as const;
export type GovernedToolReason = (typeof GOVERNED_TOOL_REASONS)[keyof typeof GOVERNED_TOOL_REASONS] | string;

/** Persisted on the Session record when a thread was started with governed
 * dynamic tools. A Session without it, or whose thread differs, refuses every
 * item/tool/call: resumed or pre-existing threads never inherit governance. */
export const SessionGovernanceSchema = z.object({
  attemptId: LocalIdSchema,
  threadId: z.string().min(1),
  tools: z.array(z.enum(GOVERNED_TOOLS)).min(1).max(GOVERNED_TOOLS.length).refine((tools) => new Set(tools).size === tools.length),
  declaredAt: z.string().datetime({ offset: true }),
}).strict();
export type SessionGovernance = z.infer<typeof SessionGovernanceSchema>;

/** Inbound app-server request `item/tool/call` (DynamicToolCallParams). Unknown
 * extra fields are ignored; every used field is validated. */
export const DynamicToolCallParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1).max(255),
  tool: z.string().min(1).max(255),
  namespace: z.string().nullable().optional(),
  arguments: z.unknown(),
});
export type DynamicToolCallParams = z.infer<typeof DynamicToolCallParamsSchema>;

export interface DynamicToolCallResponse {
  success: boolean;
  contentItems: { type: "inputText"; text: string }[];
}
export interface FunctionDynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: ToolParameterSchema;
}

/** Exact declaration sent in thread/start.dynamicTools. Pure data, no authority. */
export function fileReadDynamicToolSpec(): FunctionDynamicToolSpec {
  return { type: "function", name: GOVERNED_FILE_READ_WIRE_NAME, description: FILE_READ_DESCRIPTION, inputSchema: structuredClone(FILE_READ_PARAMETERS) };
}
export function governedDynamicToolSpec(tool: GovernedToolName): FunctionDynamicToolSpec {
  if (tool === GOVERNED_FILE_READ_TOOL) return fileReadDynamicToolSpec();
  const contract = gitToolContract(tool);
  return { type: "function", name: contract.wire, description: contract.description, inputSchema: structuredClone(contract.parameters) };
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  TOOL_CALL_NOT_DECLARED: "Governed local tools are not available on this session. They are only offered to sessions started with governed tools; start a new session.",
  TOOL_CALL_UNKNOWN_TOOL: "That tool is not governed by this host.",
  TOOL_CALL_DUPLICATE: "This call id was already handled; it cannot be replayed.",
  TOOL_CALL_CANCELLED: "The call was cancelled before it completed.",
  TOOL_CALL_STALE_TURN: "The call belongs to a turn that is no longer active.",
  TOOL_CALL_HOST_UNAVAILABLE: "The governed host is unavailable; the call was not executed.",
  TOOL_CALL_READINESS_LOST: "The Policy or direct grant governing this tool changed after the call was admitted; the call was not executed.",
  TOOL_CALL_TIMED_OUT: "The governed operation did not complete within the host deadline and was terminated.",
  FILE_READ_ARGUMENTS_INVALID: "Arguments must be exactly {\"path\": \"<relative path>\"}.",
  FILE_READ_PATH_INVALID: "Path must be relative to the project root, use forward slashes, and must not contain '..', '.', or unsupported characters.",
  FILE_READ_SENSITIVE_PATH: "That path is a secret-bearing location (for example .env, credentials, private keys, .git) and is always refused.",
  FILE_READ_SYMLINK_REFUSED: "That path passes through a symbolic link; governed reads only follow the literal project path. Use the real path of the target file.",
  FILE_READ_NOT_FOUND: "No file exists at that path inside the project.",
  FILE_READ_NOT_A_FILE: "That path is not a regular file.",
  FILE_READ_TOO_LARGE: "The file exceeds the 256 KiB governed read limit.",
  FILE_READ_NOT_UTF8: "The file is not valid UTF-8 text.",
  FILE_READ_WORKSPACE_DRIFT: "The project folder changed while the file was being read; retry.",
  GIT_ARGUMENTS_INVALID: "Arguments do not match the closed contract for this read-only Git operation.",
  GIT_PATH_INVALID: "Git diff requires exactly one safe workspace-relative literal file path.",
  GIT_REVISION_INVALID: "Revision must be one non-option revision name; ranges and revision expressions are refused.",
  GIT_REPOSITORY_REFUSED: "This repository configuration is outside the fail-closed read-only Git profile.",
  GIT_WORKSPACE_DRIFT: "The project folder changed before Git started; retry.",
  GIT_PROCESS_FAILED: "The bounded read-only Git process did not complete successfully.",
  GIT_OUTPUT_TOO_LARGE: "Git output exceeded the governed byte limit.",
  GIT_OUTPUT_NOT_UTF8: "Git output is not valid UTF-8 text.",
  GIT_SENSITIVE_OUTPUT: "Git output could expose a secret-bearing path or credential and was refused.",
  EXECUTION_OWNER_STALE: "Governed tools from this session belong to an earlier host run and cannot be used after a restart; start a new session.",
  TOOL_POLICY_DENIED: "The active Policy denies reading that path.",
  TOOL_PROTECTED_NOT_READY: "The active Policy requires approval, which this governed read lane does not support.",
};
/** Redacted response text: a closed code plus a fixed sentence. Never interpolate
 * paths, exception messages or file bytes into a refusal. */
export function governedRefusal(code: string): DynamicToolCallResponse {
  const reason = GovernedToolReasonCodeSchema.parse(code);
  const text = REASON_TEXT[reason] ?? "The governed host refused this call.";
  return { success: false, contentItems: [{ type: "inputText", text: `${reason}: ${text}` }] };
}

/** Durable domain event for one governed call (SQLite migration 10). Data is the
 * redacted audit projection: tool, call id and the logical claim path. Never the
 * file bytes, native path, arguments beyond the claim, or exception text. */
export const GovernedToolEventTypeSchema = z.enum(["admitted", "denied", "completed", "failed", "cancelled"]);
export type GovernedToolEventType = z.infer<typeof GovernedToolEventTypeSchema>;
const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const GovernedToolEventInputSchema = z.object({
  event_id: z.string().uuid(),
  session_id: LocalIdSchema, attempt_id: LocalIdSchema,
  thread_id: z.string().min(1), turn_id: z.string().min(1), call_id: z.string().min(1).max(255),
  tool_name: z.enum(GOVERNED_TOOLS),
  event_type: GovernedToolEventTypeSchema,
  reason_code: GovernedToolReasonCodeSchema.nullable(),
  plan_hash: Sha256.nullable(),
  result_hash: Sha256.nullable(), result_bytes: z.number().int().nonnegative().safe().nullable(),
  request_id: z.string().uuid(), causation_id: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  data: z.object({
    tool: z.enum(GOVERNED_TOOLS), call_id: z.string().min(1), wire_tool: z.string().min(1), path: z.string().nullable(),
    process: z.object({ placement: z.literal("local_trusted"), isolation: z.literal("none"), exit_code: z.number().int().nullable(),
      stdout_hash: Sha256, stdout_bytes: z.number().int().nonnegative().safe(), stderr_hash: Sha256,
      stderr_bytes: z.number().int().nonnegative().safe(), truncated: z.boolean(), timed_out: z.boolean(), cancelled: z.boolean() }).strict().nullable().optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const terminal = ["completed", "failed", "cancelled"].includes(value.event_type);
  if ((value.event_type === "admitted" || value.event_type === "completed") !== (value.reason_code === null)) ctx.addIssue({ code: "custom", message: "reason/event mismatch" });
  if (value.event_type !== "denied" && value.plan_hash === null) ctx.addIssue({ code: "custom", message: "plan hash required" });
  if ((value.event_type === "completed") !== (value.result_hash !== null && value.result_bytes !== null)) ctx.addIssue({ code: "custom", message: "result/event mismatch" });
  if (value.data.call_id !== value.call_id) ctx.addIssue({ code: "custom", message: "data call drift" });
  if (value.data.tool !== value.tool_name) ctx.addIssue({ code: "custom", message: "data tool drift" });
  void terminal;
});
export type GovernedToolEventInput = z.infer<typeof GovernedToolEventInputSchema>;
