import type { ProviderCoverage } from "./provider-call-contracts";
import { z } from "zod";

export const IPC = {
  bootstrap: "orchestrion:bootstrap",
  chooseProjectDirectory: "orchestrion:choose-project-directory",
  chooseAttachments: "orchestrion:choose-attachments",
  chooseAttachmentFolder: "orchestrion:choose-attachment-folder",
  describeDroppedAttachments: "orchestrion:describe-dropped-attachments",
  loadAttachmentPreviews: "orchestrion:load-attachment-previews",
  listWorkspaceDirectory: "orchestrion:list-workspace-directory",
  readWorkspaceFile: "orchestrion:read-workspace-file",
  saveWorkspaceFile: "orchestrion:save-workspace-file",
  openWorkspaceFile: "orchestrion:open-workspace-file",
  createTerminal: "orchestrion:create-terminal",
  terminalInput: "orchestrion:terminal-input",
  acknowledgeTerminalOutput: "orchestrion:acknowledge-terminal-output",
  resizeTerminal: "orchestrion:resize-terminal",
  closeTerminal: "orchestrion:close-terminal",
  closeSessionTerminals: "orchestrion:close-session-terminals",
  terminalEvent: "orchestrion:terminal-event",
  createProject: "orchestrion:create-project",
  createAgent: "orchestrion:create-agent",
  bindSessionAgent: "orchestrion:bind-session-agent",
  createSession: "orchestrion:create-session",
  startSession: "orchestrion:start-session",
  listModels: "orchestrion:list-models",
  renameProject: "orchestrion:rename-project",
  renameAgent: "orchestrion:rename-agent",
  deleteProject: "orchestrion:delete-project",
  deleteAgent: "orchestrion:delete-agent",
  renameSession: "orchestrion:rename-session",
  deleteSession: "orchestrion:delete-session",
  updateSessionSettings: "orchestrion:update-session-settings",
  sendMessage: "orchestrion:send-message",
  stopTurn: "orchestrion:stop-turn",
  respondToRequest: "orchestrion:respond-to-request",
  restartCodex: "orchestrion:restart-codex",
  windowState: "orchestrion:window-state",
  event: "orchestrion:event",
} as const;

/**
 * Increment when a renderer-visible preload contract changes incompatibly.
 * This value lives in the isolated preload world, so a missing/older value is
 * an actionable signal that Electron must be restarted rather than HMR-reloaded.
 */
export const DESKTOP_BRIDGE_VERSION = 5 as const;

export interface DesktopBridgeInfo {
  readonly version: typeof DESKTOP_BRIDGE_VERSION;
  readonly capabilities: {
    readonly sessionTree: { readonly bindSessionAgent: true };
    readonly localAgents: { readonly directToolGrants: true };
    readonly workspaceFiles: {
      readonly read: true;
      readonly save: true;
      readonly open: true;
    };
  };
}

export type AppServerStatus = "starting" | "ready" | "stopped" | "error";
export type SessionStatus = "idle" | "starting" | "running" | "waiting" | "failed";
export type MessageRole = "user" | "assistant" | "system";
export type MessagePhase = "commentary" | "final_answer" | null;
export type ConversationActivityKind =
  | "reasoning"
  | "command"
  | "tool"
  | "file_change"
  | "subagent"
  | "compaction"
  | "web_search"
  | "image_view";
export type ConversationActivityStatus = "running" | "completed" | "failed" | "declined";
export type AttachmentKind = "image" | "audio" | "file" | "folder";
export type SessionTitleSource = "provisional" | "codex" | "manual";

export interface ProjectRecord {
  executionMode?: "native" | "governed";
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface AgentRecord {
  executionMode?: "native" | "governed";
  localAgentVersionId?: string;
  id: string;
  projectId: string;
  name: string;
  instructions: string;
  createdAt: string;
}

export interface SessionRecord {
  executionMode?: "native" | "governed";
  id: string;
  agentId: string;
  title: string;
  threadId: string | null;
  model: string | null;
  modelProvider: string | null;
  reasoningEffort: string | null;
  serviceTier?: string | null;
  titleSource: SessionTitleSource;
  createdAt: string;
  updatedAt: string;
  /** Set only when this Session's thread was started with governed dynamic tools
   * (EP1-B). Absent/null means the native Codex lane only; a resumed or
   * pre-existing thread never gains governance after the fact. */
  governance?: import("./governed-tool-contracts").SessionGovernance | null;
}

export interface ComposerAttachment {
  id: string;
  path: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string | null;
  size: number | null;
  previewUrl: string | null;
}

export interface ModelReasoningEffort {
  reasoningEffort: string;
  description: string;
}

export interface ModelServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface ModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  providerId: string | null;
  providerDisplayName: string | null;
  supportedReasoningEfforts: ModelReasoningEffort[];
  defaultReasoningEffort: string;
  serviceTiers?: ModelServiceTier[];
  defaultServiceTier?: string | null;
  isDefault: boolean;
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  turnId?: string | null;
  role: MessageRole;
  text: string;
  phase: MessagePhase;
  createdAt: string;
  streaming?: boolean;
  attachments?: ComposerAttachment[];
  activity?: ConversationActivity;
}

/**
 * A bounded, privacy-safe projection of an app-server item for the Local UI.
 * Raw reasoning content is deliberately absent: only the public summary can
 * populate `result` for a reasoning activity.
 */
export interface ConversationActivity {
  kind: ConversationActivityKind;
  label: string;
  status: ConversationActivityStatus;
  summary?: string;
  arguments?: string;
  result?: string;
  error?: string;
  metadata?: Array<{ label: string; value: string }>;
  durationMs?: number;
}

/**
 * Thread-scoped context telemetry emitted by Codex app-server.
 *
 * `usedTokens` is the app-server's `tokenUsage.last.totalTokens`, not the
 * lifetime/cumulative `tokenUsage.total.totalTokens` value. Either numeric
 * field may be unavailable when the runtime cannot report it.
 */
export interface ContextWindowUsage {
  turnId: string;
  usedTokens: number | null;
  contextWindowTokens: number | null;
}

export interface RuntimeDiagnostic {
  code: "codex_not_found" | "spawn_failed" | "handshake_failed" | "auth_required" | "protocol_error" | "server_exited";
  message: string;
  detail?: string;
}

export type ApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: { host: string; action: "allow" | "deny" } } };

export interface UserInputOption {
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  header?: string;
  question: string;
  options?: UserInputOption[];
  isOther?: boolean;
  isSecret?: boolean;
}

export interface PermissionGrant {
  network?: Record<string, unknown>;
  fileSystem?: Record<string, unknown>;
  macos?: Record<string, unknown>;
}

export type McpElicitationMode = "form" | "openai/form" | "openaiForm" | "url";

export interface McpElicitationRequest {
  mode: McpElicitationMode;
  serverName: string;
  message: string;
  requestedSchema?: unknown;
  url?: string;
  elicitationId?: string;
}

export interface PendingRequest {
  requestId: string | number;
  sessionId: string;
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/tool/requestUserInput"
    | "item/permissions/requestApproval"
    | "mcpServer/elicitation/request";
  title: string;
  detail: string;
  command?: string;
  cwd?: string;
  availableDecisions?: ApprovalDecision[];
  questions?: UserInputQuestion[];
  requestedPermissions?: PermissionGrant;
  elicitation?: McpElicitationRequest;
  createdAt: string;
}

export interface SessionRuntime {
  /** Computed host provenance; absent legacy data proves no governed coverage. */
  providerCoverage?: ProviderCoverage;
  status: SessionStatus;
  activeTurnId: string | null;
  messages: ConversationMessage[];
  pendingRequests: PendingRequest[];
  error: string | null;
  contextWindowUsage?: ContextWindowUsage | null;
}

export interface DesktopSnapshot {
  appServer: {
    status: AppServerStatus;
    codexVersion: string | null;
    diagnostic: RuntimeDiagnostic | null;
  };
  projects: ProjectRecord[];
  agents: AgentRecord[];
  sessions: SessionRecord[];
  runtimes: Record<string, SessionRuntime>;
}

export interface CreateProjectInput { name: string; path: string }
export interface CreateAgentInput { projectId: string; name: string; instructions: string }
export interface CreateSessionInput {
  agentId: string;
  title?: string;
  titleSource?: SessionTitleSource;
  model?: string | null;
  modelProvider?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
}
export interface StartSessionInput extends CreateSessionInput {
  text: string;
  attachments?: ComposerAttachment[];
}
export interface RenameProjectInput { projectId: string; name: string }
export interface RenameAgentInput { agentId: string; name: string }
export interface DeleteProjectInput { projectId: string }
export interface DeleteAgentInput { agentId: string }
export interface RenameSessionInput { sessionId: string; title: string }
export interface DeleteSessionInput { sessionId: string }
export interface UpdateSessionSettingsInput {
  sessionId: string;
  model: string;
  modelProvider?: string | null;
  reasoningEffort: string | null;
  serviceTier?: string | null;
}
export interface SendMessageInput { sessionId: string; text: string; attachments?: ComposerAttachment[] }
export interface StopTurnInput { sessionId: string }
export interface LoadAttachmentPreviewsInput { sessionId: string }

export const WORKSPACE_DIRECTORY_ENTRY_LIMIT = 500;

export interface ListWorkspaceDirectoryInput {
  sessionId: string;
  relativePath: string;
}

export type WorkspaceEntryKind = "file" | "directory" | "other";

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  symbolicLink: boolean;
  accessible: boolean;
}

export interface WorkspaceDirectoryListing {
  path: string;
  entries: WorkspaceDirectoryEntry[];
  truncated: boolean;
}

/** IPC preview bounds include the source bytes, before data-URL base64 expansion. */
export const WORKSPACE_TEXT_FILE_LIMIT = 2 * 1024 * 1024;
export const WORKSPACE_MEDIA_PREVIEW_LIMIT = 10 * 1024 * 1024;

export type WorkspaceFileKind = "text" | "image" | "pdf" | "audio" | "video" | "unsupported";
export type WorkspaceFileOpenDestination = "system" | "vscode" | "cursor";

export interface ReadWorkspaceFileInput {
  sessionId: string;
  relativePath: string;
}

export interface SaveWorkspaceFileInput extends ReadWorkspaceFileInput {
  content: string;
  expectedRevision: string;
}

export interface OpenWorkspaceFileInput extends ReadWorkspaceFileInput {
  destination: WorkspaceFileOpenDestination;
}

export interface WorkspaceFileMetadata {
  path: string;
  name: string;
  kind: WorkspaceFileKind;
  mimeType: string | null;
  size: number;
  editable: boolean;
}

export type WorkspaceFileReadResult = WorkspaceFileMetadata & (
  | { status: "ready"; revision: string; content: { type: "text"; text: string } | { type: "data-url"; dataUrl: string } }
  | { status: "too-large"; maxBytes: number }
  | { status: "unsupported"; reason: string }
);

export interface WorkspaceFileSaveResult {
  path: string;
  size: number;
  revision: string;
  modifiedAt: string;
}

export interface WorkspaceFileOpenResult {
  destination: WorkspaceFileOpenDestination;
}

export const TERMINAL_MIN_COLUMNS = 2;
export const TERMINAL_MAX_COLUMNS = 500;
export const TERMINAL_MIN_ROWS = 1;
export const TERMINAL_MAX_ROWS = 300;
export const TERMINAL_MAX_INPUT_BYTES = 32 * 1024;
export const TERMINAL_MAX_BUFFERED_OUTPUT_BYTES = 256 * 1024;

export interface CreateTerminalInput {
  sessionId: string;
  columns: number;
  rows: number;
}

export interface TerminalHandle {
  terminalId: string;
  sessionId: string;
}

export interface TerminalInput {
  terminalId: string;
  sessionId: string;
  data: string;
}

export interface ResizeTerminalInput {
  terminalId: string;
  sessionId: string;
  columns: number;
  rows: number;
}

export interface AcknowledgeTerminalOutputInput {
  terminalId: string;
  sessionId: string;
  sequence: number;
}

export interface CloseTerminalInput {
  terminalId: string;
  sessionId: string;
}

export interface CloseSessionTerminalsInput {
  sessionId: string;
}

export type TerminalEvent =
  | { type: "output"; terminalId: string; sessionId: string; sequence: number; data: string }
  | { type: "exit"; terminalId: string; sessionId: string; exitCode: number | null; signal: number | null; reason: "exit" | "closed" };

export interface DesktopWindowState { isFullScreen: boolean }

export interface LocalAttachmentSelection {
  canceled: boolean;
  filePaths: readonly string[];
}

export function selectedAttachmentPaths(selection: LocalAttachmentSelection): string[] {
  return selection.canceled ? [] : [...selection.filePaths];
}

export type RequestResponse =
  | { requestId: string | number; kind: "approval"; decision: ApprovalDecision }
  | { requestId: string | number; kind: "userInput"; answers: Record<string, { answers: string[] }> }
  | { requestId: string | number; kind: "permissions"; permissions: PermissionGrant; scope?: "turn" | "session" }
  | { requestId: string | number; kind: "elicitation"; action: "accept" | "decline" | "cancel"; content: Record<string, unknown> | null };

export type DesktopEvent =
  | { type: "snapshot"; snapshot: DesktopSnapshot }
  | { type: "diagnostic"; diagnostic: RuntimeDiagnostic }
  | { type: "request-resolved"; requestId: string | number; sessionId: string };

export interface OrchestrionDesktopApi {
  localAgentSoul?: {
    request(input: import("./agent-soul-ui-contracts").LocalAgentSoulRequest): Promise<import("./agent-soul-ui-contracts").LocalAgentSoulValue>;
  };
  localRealtime?: import("./realtime-contracts").LocalRealtimeApi;
  localAssignments: {
    request(input: import("./assignment-ui-contracts").LocalAssignmentUiRequest): Promise<import("./assignment-ui-contracts").LocalAssignmentUiValue>;
  };
  localDirectSessions: {
    request(input: import("./direct-session-ui-contracts").LocalDirectSessionRequest): Promise<import("./direct-session-ui-contracts").LocalDirectSessionValue>;
  };
  localAgents: {
    snapshot(): Promise<import("./agent-ui-contracts").LocalAgentUiValue>;
    detail(agentId: string): Promise<import("./agent-ui-contracts").LocalAgentUiValue>;
    create(input: Extract<import("./agent-ui-contracts").LocalAgentUiRequest, { operation: "create" }>): Promise<import("./agent-ui-contracts").LocalAgentUiValue>;
    update(input: Extract<import("./agent-ui-contracts").LocalAgentUiRequest, { operation: "update" }>): Promise<import("./agent-ui-contracts").LocalAgentUiValue>;
    createVersion(input: Extract<import("./agent-ui-contracts").LocalAgentUiRequest, { operation: "version.create" }>): Promise<import("./agent-ui-contracts").LocalAgentUiValue>;
    delete(input: Extract<import("./agent-ui-contracts").LocalAgentUiRequest, { operation: "delete" }>): Promise<import("./agent-ui-contracts").LocalAgentUiValue>;
  };
  localPolicies: {
    snapshot(): Promise<import("./policy/p2-ui-contracts").LocalPolicyUiValue>;
    draft(input: Extract<import("./policy/p2-ui-contracts").LocalPolicyUiRequest, { operation: "draft" }>): Promise<import("./policy/p2-ui-contracts").LocalPolicyUiValue>;
    transition(input: Extract<import("./policy/p2-ui-contracts").LocalPolicyUiRequest, { operation: "transition" }>): Promise<import("./policy/p2-ui-contracts").LocalPolicyUiValue>;
    select(input: Extract<import("./policy/p2-ui-contracts").LocalPolicyUiRequest, { operation: "select" }>): Promise<import("./policy/p2-ui-contracts").LocalPolicyUiValue>;
    simulate(input: Extract<import("./policy/p2-ui-contracts").LocalPolicyUiRequest, { operation: "simulate" }>): Promise<import("./policy/p2-ui-contracts").LocalPolicyUiValue>;
  };
  credentialReadiness(wire: string): Promise<import("./credential-contracts").CredentialResult>;
  codexAccount(request: import("./codex-account-ui-contracts").CodexAccountUiRequest): Promise<import("./codex-account-ui-contracts").CodexAccountUiValue>;
  readonly bridgeInfo: DesktopBridgeInfo;
  bootstrap(): Promise<DesktopSnapshot>;
  chooseProjectDirectory(): Promise<string | null>;
  chooseAttachments(): Promise<ComposerAttachment[]>;
  chooseAttachmentFolder(): Promise<ComposerAttachment | null>;
  resolveDroppedAttachments(files: readonly unknown[]): Promise<ComposerAttachment[]>;
  loadAttachmentPreviews(input: LoadAttachmentPreviewsInput): Promise<Record<string, string>>;
  listWorkspaceDirectory(input: ListWorkspaceDirectoryInput): Promise<WorkspaceDirectoryListing>;
  readWorkspaceFile(input: ReadWorkspaceFileInput): Promise<WorkspaceFileReadResult>;
  saveWorkspaceFile(input: SaveWorkspaceFileInput): Promise<WorkspaceFileSaveResult>;
  openWorkspaceFile(input: OpenWorkspaceFileInput): Promise<WorkspaceFileOpenResult>;
  createTerminal(input: CreateTerminalInput): Promise<TerminalHandle>;
  sendTerminalInput(input: TerminalInput): Promise<void>;
  acknowledgeTerminalOutput(input: AcknowledgeTerminalOutputInput): Promise<void>;
  resizeTerminal(input: ResizeTerminalInput): Promise<void>;
  closeTerminal(input: CloseTerminalInput): Promise<void>;
  closeSessionTerminals(input: CloseSessionTerminalsInput): Promise<void>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  createAgent(input: CreateAgentInput): Promise<AgentRecord>;
  bindSessionAgent(input: import("./session-tree-contracts").BindSessionAgentInput): Promise<AgentRecord>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  startSession(input: StartSessionInput): Promise<SessionRecord>;
  listModels(): Promise<ModelOption[]>;
  renameProject(input: RenameProjectInput): Promise<ProjectRecord>;
  renameAgent(input: RenameAgentInput): Promise<AgentRecord>;
  deleteProject(input: DeleteProjectInput): Promise<void>;
  deleteAgent(input: DeleteAgentInput): Promise<void>;
  renameSession(input: RenameSessionInput): Promise<SessionRecord>;
  deleteSession(input: DeleteSessionInput): Promise<void>;
  updateSessionSettings(input: UpdateSessionSettingsInput): Promise<SessionRecord>;
  sendMessage(input: SendMessageInput): Promise<void>;
  stopTurn(input: StopTurnInput): Promise<void>;
  respondToRequest(input: RequestResponse): Promise<void>;
  restartCodex(): Promise<void>;
  getWindowState(): Promise<DesktopWindowState>;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  onTerminalEvent(listener: (event: TerminalEvent) => void): () => void;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
  updaterBridge: UpdaterBridgeApi;
}

/** Explicit main-process update commands; the renderer never accesses Node. */
export const UPDATER_IPC = {
  check: "orchestrion:updater-check",
  download: "orchestrion:updater-download",
  quitAndInstall: "orchestrion:updater-quit-and-install",
  getState: "orchestrion:updater-get-state",
  state: "orchestrion:updater-state",
} as const;

export type UpdaterPhase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error";

export interface UpdaterChangelogEntry {
  readonly version: string;
  readonly notes: readonly string[];
}

export interface UpdaterState {
  readonly phase: UpdaterPhase;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  readonly progressPercent: number | null;
  readonly changelog: readonly UpdaterChangelogEntry[];
  readonly error: string | null;
}

export const UpdaterStateSchema = z.object({
  phase: z.enum(["idle", "checking", "available", "downloading", "ready", "installing", "error"]),
  currentVersion: z.string().min(1).max(80),
  availableVersion: z.string().min(1).max(80).nullable(),
  progressPercent: z.number().finite().min(0).max(100).nullable(),
  changelog: z.array(z.object({ version: z.string().min(1).max(80), notes: z.array(z.string().max(500)).max(20) }).strict()).max(10),
  error: z.string().max(200).nullable(),
}).strict();

export interface UpdaterBridgeApi {
  check(): Promise<UpdaterState>;
  download(): Promise<UpdaterState>;
  quitAndInstall(): Promise<void>;
  getState(): Promise<UpdaterState>;
  onState(listener: (state: UpdaterState) => void): () => void;
}

declare global {
  interface Window { orchestrion: OrchestrionDesktopApi }
}
