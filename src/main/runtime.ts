import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { nativeProviderCoverage } from "../shared/provider-call-contracts";
import { GOVERNED_SESSION_NOT_READY_MESSAGE } from "../shared/session-tree-contracts";
import type {
  AgentRecord, ComposerAttachment, ConversationMessage, CreateAgentInput, CreateProjectInput,
  ContextWindowUsage, CreateSessionInput, DeleteSessionInput, DesktopEvent, DesktopSnapshot, ModelOption, PendingRequest, ProjectRecord,
  RenameAgentInput, RenameProjectInput, DeleteAgentInput, DeleteProjectInput, RenameSessionInput, RequestResponse, RuntimeDiagnostic, SendMessageInput, SessionRecord, SessionRuntime,
  LoadAttachmentPreviewsInput, StartSessionInput, StopTurnInput, UpdateSessionSettingsInput,
  ListWorkspaceDirectoryInput, WorkspaceDirectoryListing,
  OpenWorkspaceFileInput, ReadWorkspaceFileInput, SaveWorkspaceFileInput,
  WorkspaceFileOpenResult, WorkspaceFileReadResult, WorkspaceFileSaveResult,
} from "../shared/contracts";
import { CodexLaunchError, launchCodex, type RunningCodex } from "./codex-process";
import type { RequestId } from "./json-rpc";
import { asError } from "./json-rpc";
import type { MetadataStore, StoredMetadata } from "./store";
import {
  approvalDecisionAllowed,
  validateElicitationContent,
} from "../shared/request-contracts";
import type { ApprovalDecision, McpElicitationRequest } from "../shared/contracts";
import { describeAttachments, recentUniquePaths } from "./attachments";
import { contextWindowUsageFromNotification } from "../shared/context-window";
import { listProjectDirectory, readProjectFile, saveProjectTextFile } from "./workspace-files";
import { resolveProjectFilePath } from "./workspace-files";
import { openProjectFile } from "./workspace-file-open";
import type { GovernedToolHost } from "./governed-tools";
import { GOVERNED_TOOL_REASONS, governedRefusal, type DynamicToolCallResponse } from "../shared/governed-tool-contracts";
import {
  activityFromItem,
  activityText,
  appendActivityOutput,
  appendReasoningSummary,
} from "./activity-presentation";

type JsonObject = Record<string, unknown>;
type Launch = (assertActive: AssertRequestActive) => Promise<RunningCodex>;
export type { AssertRequestActive } from "./request-guard";
import { hostOwnedWork as unscopedRequest, type AssertRequestActive } from "./request-guard";

type BeforeSessionDelete = (sessionId: string) => void | Promise<void>;
interface StartingCodex { generation: number; promise: Promise<void> }
/** One turn-scoped envelope held back while its session's `turn/start` is in
 * flight and no turn is active yet. `key` is the JSON-RPC request key of a
 * server request (the id stays claimed while held) and null for a notification. */
interface DeferredEnvelope { kind: "serverRequest" | "notification"; key: string | null; connection: RunningCodex["connection"]; envelope: JsonObject }
/** Per-session record kept for the whole of `sendMessage`'s "starting" window:
 * from before its first await (server, thread — including `thread/resume` —
 * then `turn/start`) until the last has settled. */
interface StartingTurn { completedEarly: Map<string, JsonObject>; deferred: DeferredEnvelope[] }
/** One in-flight governed item/tool/call. `superseded` is set once a newer call
 * has been admitted under the same JSON-RPC id after this one was cancelled. */
interface ToolCallEntry { sessionId: string; turnId: string | null; controller: AbortController; superseded: boolean }
/** Hard deadline for one governed call, counted from host execution start. The
 * governed read observes its AbortSignal only between filesystem phases
 * (workspace-files.ts polls it before open and before every chunk; lstat,
 * realpath, stat, open and read themselves are not abortable), so a phase that
 * never settles would otherwise keep the call's entry and the server's
 * outstanding request alive forever. The race lives here, at the bookkeeping
 * level, independent of whether the filesystem layer ever returns. */
export const GOVERNED_TOOL_CALL_DEADLINE_MS = 30_000;
const TURN_COMPLETION_RECONCILE_DELAYS_MS = [250, 1_000, 3_000] as const;
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

const EMPTY_RUNTIME = (): SessionRuntime => ({ providerCoverage: nativeProviderCoverage(), status: "idle", activeTurnId: null, messages: [], pendingRequests: [], error: null, contextWindowUsage: null });

function contextModelKey(session: Pick<SessionRecord, "model" | "modelProvider">): string {
  return `${session.modelProvider ?? ""}\u0000${session.model ?? ""}`;
}

/** A known refusal before native thread creation, not an uncertain transport outcome. */
export class GovernedSessionReadinessError extends Error {
  readonly code = "GOVERNED_SESSION_NOT_READY" as const;
  constructor() { super(GOVERNED_SESSION_NOT_READY_MESSAGE); }
}

export class DesktopRuntime extends EventEmitter {
  private metadata: StoredMetadata = { projects: [], agents: [], sessions: [] };
  private readonly runtimes: Record<string, SessionRuntime> = {};
  private appServer: DesktopSnapshot["appServer"] = { status: "stopped", codexVersion: null, diagnostic: null };
  private running: RunningCodex | null = null;
  private readonly joinedThreads = new Set<string>();
  private readonly threadToSession = new Map<string, string>();
  private readonly pendingById = new Map<string, PendingRequest>();
  private readonly interruptingTurns = new Set<string>();
  /** Sessions whose `sendMessage` is starting a turn: registered before its
   * first await (server, thread — `thread/resume` for a thread already mapped
   * to the session — then `turn/start`) and removed once the last has settled.
   * The connection dispatches every message of one received chunk
   * synchronously, but an awaited result reaches `sendMessage` only as a
   * microtask, so anything sharing any of those results' chunks runs before
   * the continuation names the turn.
   * Each record keeps the turns `turn/completed` retired before then (they
   * would otherwise be dropped and the continuation would promote a finished
   * turn) and the turn-scoped envelopes that named a turn while none was
   * active (they would otherwise be refused as stale although the turn they
   * name may be the one about to be confirmed). */
  private readonly startingTurns = new Map<string, StartingTurn>();
  private readonly latestTurnBySession = new Map<string, string>();
  private readonly contextUsageAwaitingCurrentModel = new Set<string>();
  private readonly latestContextUsageBySession = new Map<string, ContextWindowUsage>();
  private readonly contextWindowBySessionModel = new Map<string, Map<string, number | null>>();
  private readonly sessionOperations = new Map<string, Promise<void>>();
  /** A final answer normally precedes `turn/completed` by only a few
   * milliseconds. If that notification is lost, confirm the persisted turn
   * state through `thread/read` before releasing the composer. */
  private readonly completionReconciliations = new Map<string, { turnId: string; timer: ReturnType<typeof setTimeout> }>();
  /** In-flight governed item/tool/call executions, cancellable by turn, session or host. */
  private readonly toolCalls = new Map<string, ToolCallEntry>();
  /** Cancelled calls whose host settlement is still pending. A later call admitted
   * under the same JSON-RPC id marks its predecessor superseded so the late
   * answer is never delivered under an id the newer call now owns. */
  private readonly cancelledToolCalls = new Map<string, ToolCallEntry>();
  /** Sessions whose deletion has been decided but not yet completed; mirrors
   * `interruptingTurns` so no governed call is admitted for them meanwhile. */
  private readonly deletingSessions = new Set<string>();
  private starting: StartingCodex | null = null;
  private generation = 0;
  private publishingSuspended = false;

  constructor(private readonly store: MetadataStore, private readonly launch: Launch = (assertActive) => launchCodex({ assertActive }),
    private readonly governed: GovernedToolHost | null = null) {
    super();
  }

  async bootstrap(): Promise<DesktopSnapshot> {
    this.metadata = await this.store.read();
    for (const session of this.metadata.sessions) {
      this.runtimes[session.id] ??= EMPTY_RUNTIME();
      if (session.threadId) this.threadToSession.set(session.threadId, session.id);
    }
    try {
      await this.ensureServer();
      await Promise.all(this.metadata.sessions.filter((session) => session.threadId).map((session) => this.hydrateHistory(session)));
    } catch {
      // Startup already publishes the contract diagnostic; bootstrap still returns it to a newly mounted renderer.
    }
    return this.snapshot();
  }

  async createProject(input: CreateProjectInput, assertActive: AssertRequestActive = unscopedRequest): Promise<ProjectRecord> {
    assertActive();
    const record = await this.store.createProject(input, assertActive);
    this.metadata.projects.push(record);
    this.publish();
    return record;
  }

  async createAgent(input: CreateAgentInput, assertActive: AssertRequestActive = unscopedRequest): Promise<AgentRecord> {
    assertActive();
    const record = await this.store.createAgent(input, assertActive);
    this.metadata.agents.push(record);
    this.publish();
    return record;
  }

  async bindSessionAgent(input: import("../shared/session-tree-contracts").BindSessionAgentInput, assertActive: AssertRequestActive = unscopedRequest): Promise<AgentRecord> {
    assertActive();
    if (!this.store.bindSessionAgent) throw new Error("SERVICE_UNAVAILABLE");
    const record = await this.store.bindSessionAgent(input, assertActive);
    // Publication follows the committed store result, including idempotent replay.
    // Session objects may be held by active operations: never replace them here.
    const stored = await this.store.read();
    this.metadata.projects = stored.projects;
    this.metadata.agents = stored.agents;
    this.publish();
    return record;
  }

  async createSession(input: CreateSessionInput, assertActive: AssertRequestActive = unscopedRequest): Promise<SessionRecord> {
    assertActive();
    const record = await this.store.createSession(input, assertActive);
    this.metadata.sessions.push(record);
    this.runtimes[record.id] = EMPTY_RUNTIME();
    this.publish();
    return record;
  }

  async startSession(input: StartSessionInput, assertActive: AssertRequestActive = unscopedRequest): Promise<SessionRecord> {
    assertActive = this.bindNativeRequest(assertActive);
    assertActive();
    const text = input.text.trim();
    const attachments = normalizedAttachments(input.attachments);
    if (!text && attachments.length === 0) throw new Error("A message or attachment is required");
    const record = await this.createSession({
      agentId: input.agentId,
      title: provisionalSessionTitle(text, attachments),
      titleSource: "provisional",
      model: input.model,
      modelProvider: input.modelProvider,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier,
    }, assertActive);
    try {
      await this.sendMessage({ sessionId: record.id, text, attachments }, assertActive);
      return structuredClone(this.context(record.id).session);
    } catch (error) {
      await this.withSessionLock(record.id, async () => {
        const session = this.metadata.sessions.find((candidate) => candidate.id === record.id);
        if (!session) return;
        if (session.threadId) {
          try {
            await this.connection().request("thread/delete", { threadId: session.threadId });
          } catch {
            // The local transaction must still roll back if remote cleanup is unavailable.
          }
          this.threadToSession.delete(session.threadId);
          this.joinedThreads.delete(session.threadId);
        }
        await this.store.deleteSession(record.id); // host-owned rollback of a committed provisional record
        this.governed?.release(record.id);
        this.latestContextUsageBySession.delete(record.id);
        this.contextWindowBySessionModel.delete(record.id);
        delete this.runtimes[record.id];
        this.metadata.sessions = this.metadata.sessions.filter((candidate) => candidate.id !== record.id);
        this.publish();
      });
      throw error;
    }
  }

  async listModels(assertActive: AssertRequestActive = unscopedRequest): Promise<ModelOption[]> {
    assertActive = this.bindNativeRequest(assertActive);
    await this.ensureServer(assertActive);
    const models: ModelOption[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      assertActive();
      const result = object(await this.connection().request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      }));
      for (const value of array(result.data)) {
        const parsed = modelOption(object(value));
        if (parsed) models.push(parsed);
      }
      cursor = optionalString(result.nextCursor) ?? null;
      if (cursor && seenCursors.has(cursor)) throw new Error("Codex model catalog returned a repeated pagination cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return models;
  }

  async loadAttachmentPreviews(input: LoadAttachmentPreviewsInput): Promise<Record<string, string>> {
    const { runtime } = this.context(input.sessionId);
    const imagePaths = recentUniquePaths(runtime.messages.flatMap((item) => item.attachments ?? [])
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => attachment.path));
    const attachments = await describeAttachments(imagePaths);
    return Object.fromEntries(attachments.flatMap((attachment) => attachment.previewUrl ? [[attachment.path, attachment.previewUrl]] : []));
  }

  async listWorkspaceDirectory(input: ListWorkspaceDirectoryInput): Promise<WorkspaceDirectoryListing> {
    if (!input || typeof input !== "object") throw new Error("Workspace directory request is required");
    if (typeof input.sessionId !== "string") throw new Error("Session id is required");
    const sessionId = requiredText(input.sessionId, "Session id");
    if (typeof input.relativePath !== "string") throw new Error("Workspace path must be a string");
    const { project } = this.context(sessionId);
    return listProjectDirectory(project.path, input.relativePath);
  }

  async readWorkspaceFile(input: ReadWorkspaceFileInput): Promise<WorkspaceFileReadResult> {
    const { sessionId, relativePath } = workspaceFileRequest(input);
    const { project } = this.context(sessionId);
    return readProjectFile(project.path, relativePath);
  }

  async saveWorkspaceFile(input: SaveWorkspaceFileInput, assertActive: AssertRequestActive = unscopedRequest): Promise<WorkspaceFileSaveResult> {
    assertActive();
    const { sessionId, relativePath } = workspaceFileRequest(input);
    if (typeof input.content !== "string") throw new Error("Workspace file content must be a string");
    if (typeof input.expectedRevision !== "string") throw new Error("Expected workspace file revision must be a string");
    return this.runSessionOperation(sessionId, async () => {
      const { project } = this.context(sessionId);
      return saveProjectTextFile(project.path, relativePath, input.content, input.expectedRevision, assertActive);
    }, assertActive);
  }

  async openWorkspaceFile(input: OpenWorkspaceFileInput, assertActive: AssertRequestActive = unscopedRequest,
    openSystem?: (path: string) => Promise<void>): Promise<WorkspaceFileOpenResult> {
    assertActive();
    const { sessionId, relativePath } = workspaceFileRequest(input);
    if (!input || (input.destination !== "system" && input.destination !== "vscode" && input.destination !== "cursor")) {
      throw new Error("Unsupported workspace file destination");
    }
    return this.runSessionOperation(sessionId, async () => {
      const { project } = this.context(sessionId);
      if (input.destination === "system" && openSystem) {
        const path = await resolveProjectFilePath(project.path, relativePath);
        assertActive();
        await openSystem(path);
      } else {
        await openProjectFile(project.path, relativePath, input.destination, { assertActive });
      }
      return { destination: input.destination };
    }, assertActive);
  }

  projectPathForSession(sessionId: string): string {
    return this.context(sessionId).project.path;
  }

  async runSessionOperation<T>(sessionId: string, operation: () => Promise<T>, assertActive: AssertRequestActive = unscopedRequest): Promise<T> {
    const normalized = requiredText(sessionId, "Session id");
    return this.withSessionLock(normalized, async () => {
      this.context(normalized);
      return operation();
    }, assertActive);
  }

  async renameProject(input: RenameProjectInput, active: AssertRequestActive = unscopedRequest): Promise<ProjectRecord> {
    active();
    const record = this.metadata.projects.find(row => row.id === input.projectId);
    if (!record) throw new Error("Project not found");
    if (record.executionMode === "governed") throw new Error("Manage this project through Project overview.");
    if (!this.store.renameProject) throw new Error("SERVICE_UNAVAILABLE");
    const renamed = await this.store.renameProject(record.id, requiredText(input.name, "Project name"), active);
    Object.assign(record, renamed);
    this.publish();
    return structuredClone(record);
  }

  async renameAgent(input: RenameAgentInput, active: AssertRequestActive = unscopedRequest): Promise<AgentRecord> {
    active();
    const record = this.metadata.agents.find(row => row.id === input.agentId);
    if (!record) throw new Error("Agent not found");
    if (record.executionMode === "governed") throw new Error("Manage this published Agent through Agent profile.");
    if (!this.store.renameAgent) throw new Error("SERVICE_UNAVAILABLE");
    const renamed = await this.store.renameAgent(record.id, requiredText(input.name, "Agent name"), active);
    Object.assign(record, renamed);
    this.publish();
    return structuredClone(record);
  }

  async deleteProject(input: DeleteProjectInput, active: AssertRequestActive = unscopedRequest): Promise<void> {
    active();
    const record = this.metadata.projects.find(row => row.id === input.projectId);
    if (!record) throw new Error("Project not found");
    if (record.executionMode === "governed") throw new Error("Manage this project through Project overview.");
    if (!this.store.deleteProject) throw new Error("SERVICE_UNAVAILABLE");
    // The store checks emptiness in the same serialized transaction as removal.
    await this.store.deleteProject(record.id, active);
    this.metadata.projects = this.metadata.projects.filter(row => row.id !== record.id);
    this.publish();
  }

  async deleteAgent(input: DeleteAgentInput, active: AssertRequestActive = unscopedRequest): Promise<void> {
    active();
    const record = this.metadata.agents.find(row => row.id === input.agentId);
    if (!record) throw new Error("Agent not found");
    if (record.executionMode === "governed") throw new Error("Manage this published Agent through Agent profile.");
    if (!this.store.deleteAgent) throw new Error("SERVICE_UNAVAILABLE");
    await this.store.deleteAgent(record.id, active);
    this.metadata.agents = this.metadata.agents.filter(row => row.id !== record.id);
    this.publish();
  }

  async renameSession(input: RenameSessionInput, assertActive: AssertRequestActive = unscopedRequest): Promise<SessionRecord> {
    assertActive = this.bindNativeRequest(assertActive);
    assertActive();
    return this.runSessionOperation(input.sessionId, async () => {
      const { session } = this.context(input.sessionId);
      const title = requiredText(input.title, "Session title");
      if (session.threadId) {
        await this.ensureServer(assertActive);
        assertActive();
        await this.connection().request("thread/name/set", { threadId: session.threadId, name: title });
      }
      const next: SessionRecord = { ...session, title, titleSource: "manual", updatedAt: new Date().toISOString() };
      // A completed native rename must be recorded. Without a native effect this
      // remains request-owned all the way through the JSON write queue/rename.
      await this.store.updateSession(next, session.threadId ? unscopedRequest : assertActive);
      Object.assign(session, next);
      this.publish();
      return structuredClone(session);
    }, assertActive);
  }

  async deleteSession(input: DeleteSessionInput, beforeDelete: BeforeSessionDelete = () => undefined, assertActive: AssertRequestActive = unscopedRequest): Promise<void> {
    assertActive = this.bindNativeRequest(assertActive);
    assertActive();
    const sessionId = requiredText(input?.sessionId, "Session id");
    return this.withSessionLock(sessionId, async () => {
      const { session } = this.context(sessionId);
      assertActive();
      // Deletion is decided here; governed calls are aborted before any await
      // so a hung thread/delete or store write cannot let a read complete, and
      // no new call is admitted for the session while deletion is in flight.
      this.cancelToolCalls(sessionId);
      this.deletingSessions.add(sessionId);
      try {
        await beforeDelete(sessionId);
        assertActive();
        const threadId = session.threadId;
        if (threadId) {
          await this.ensureServer(assertActive);
          assertActive();
          await this.connection().request("thread/delete", { threadId });
        }

        await this.store.deleteSession(sessionId, threadId ? unscopedRequest : assertActive);
        this.governed?.release(sessionId);
        if (threadId) {
          this.threadToSession.delete(threadId);
          this.joinedThreads.delete(threadId);
        }
        for (const [key, pending] of this.pendingById) {
          if (pending.sessionId === sessionId) this.pendingById.delete(key);
        }
        for (const key of this.interruptingTurns) {
          if (key.startsWith(`${sessionId}:`)) this.interruptingTurns.delete(key);
        }
        this.cancelCompletionReconciliation(sessionId);
        this.latestTurnBySession.delete(sessionId);
        this.contextUsageAwaitingCurrentModel.delete(sessionId);
        this.latestContextUsageBySession.delete(sessionId);
        this.contextWindowBySessionModel.delete(sessionId);
        delete this.runtimes[sessionId];
        this.metadata.sessions = this.metadata.sessions.filter((candidate) => candidate.id !== sessionId);
        this.publish();
      } finally {
        // A failed deletion leaves the session in place, so admission reopens.
        this.deletingSessions.delete(sessionId);
      }
    }, assertActive);
  }

  async updateSessionSettings(input: UpdateSessionSettingsInput, assertActive: AssertRequestActive = unscopedRequest): Promise<SessionRecord> {
    assertActive = this.bindNativeRequest(assertActive);
    assertActive();
    return this.runSessionOperation(input.sessionId, async () => {
      const { session, runtime } = this.context(input.sessionId);
      const model = requiredText(input.model, "Model");
      const reasoningEffort = normalizedOptionalString(input.reasoningEffort);
      const modelProvider = input.modelProvider === undefined
        ? session.modelProvider
        : normalizedOptionalString(input.modelProvider);
      const serviceTier = input.serviceTier === undefined
        ? session.serviceTier ?? null
        : normalizedOptionalString(input.serviceTier);
      // App Server has no standalone thread settings mutation. Persist the
      // choice here; sendMessage applies it through the next turn/start.
      const next: SessionRecord = { ...session, model, modelProvider, reasoningEffort, serviceTier, updatedAt: new Date().toISOString() };
      await this.store.updateSession(next, assertActive);
      const modelChanged = session.model !== model || session.modelProvider !== modelProvider;
      Object.assign(session, next);
      if (modelChanged) this.selectContextUsageForModel(session, runtime);
      this.publish();
      return structuredClone(session);
    }, assertActive);
  }

  async sendMessage(input: SendMessageInput, assertActive: AssertRequestActive = unscopedRequest): Promise<void> {
    assertActive = this.bindNativeRequest(assertActive);
    const generation = this.generation;
    assertActive();
    return this.runSessionOperation(input.sessionId, async () => {
      const text = input.text.trim();
      const attachments = normalizedAttachments(input.attachments);
      if (!text && attachments.length === 0) throw new Error("A message or attachment is required");
      const context = this.context(input.sessionId);
      if (["starting", "running", "waiting"].includes(context.runtime.status)) throw new Error("This session already has a running turn");
      context.runtime.status = "starting";
      context.runtime.error = null;
      // The hold on turn-scoped envelopes must exist for as long as the status
      // above does: a null activeTurnId and "starting" are what every await
      // below leaves behind, not only turn/start. For a session whose thread
      // is resumed rather than started, the thread is already mapped to it, so
      // a turn/started or item/tool/call can be routed here while ensureServer
      // or thread/resume is pending — in the same chunk as that response, say —
      // and with no record to hold it, it would meet the guards exactly as the
      // in-flight turn/start leaves them and promote or admit a stale turn.
      // The record is therefore registered before the first await and stays
      // until the last one has settled, whichever way.
      const starting: StartingTurn = { completedEarly: new Map(), deferred: [] };
      this.startingTurns.set(input.sessionId, starting);
      const userMessage = message(input.sessionId, "user", text, null, randomUUID(), attachments);
      context.runtime.messages.push(userMessage);
      this.publish();

      try {
        let result: JsonObject;
        try {
          await this.ensureServer(assertActive);
          assertActive();
          const threadId = await this.ensureThread(context.session, context.agent, context.project, assertActive);
          assertActive();
          result = object(await this.connection().request("turn/start", {
            threadId,
            input: turnInputs(text, attachments),
            ...(context.session.model ? { model: context.session.model } : {}),
            ...(context.session.reasoningEffort ? { effort: context.session.reasoningEffort } : {}),
            // Explicit null clears a tier previously made sticky by turn/start.
            serviceTier: context.session.serviceTier ?? null,
          }));
        } finally {
          // The last await has settled, whichever way: nothing can arrive
          // between here and the synchronous continuation or catch path, both
          // of which consult the record directly (the buffered completions by
          // reference, the held envelopes through replayDeferred, which needs
          // the record unregistered so nothing is held a second time).
          if (this.startingTurns.get(input.sessionId) === starting) this.startingTurns.delete(input.sessionId);
        }
        if (generation !== this.generation) throw new Error("Superseded Codex app-server request");
        const turn = object(result.turn);
        const turnId = stringField(turn, "id");
        userMessage.turnId = turnId;
        if (["starting", "waiting"].includes(context.runtime.status) && context.runtime.activeTurnId === null) {
          this.latestTurnBySession.set(input.sessionId, turnId);
          // A turn that turn/completed already retired must not be promoted to
          // active, so no governed call for it is admitted; it is retired here
          // exactly as the notification would have done. The record is passed
          // explicitly: the finally above already unregistered it.
          if (!this.retireIfCompletedEarly(input.sessionId, context.runtime, turnId, starting.completedEarly)) {
            context.runtime.activeTurnId = turnId;
            if (context.runtime.status === "starting") context.runtime.status = "running";
          }
        }
        // The turn is settled either way (promoted, retired, or already named
        // or failed by a notification): the envelopes held back for this
        // session are judged now, against that state.
        this.replayDeferred(starting);
        this.publish();
      } catch (error) {
        // Restart already published the interruption; an old continuation must
        // neither resurrect its turn nor replace that state/diagnostic.
        if (generation !== this.generation) throw error;
        // turn/started may already have named this turn before the turn/start
        // result failed; a failed turn retires that id like the error path
        // does, so no governed call it admitted survives and none is admitted.
        if (context.runtime.activeTurnId !== null) this.clearPendingForTurn(input.sessionId, context.runtime.activeTurnId);
        context.runtime.activeTurnId = null;
        context.runtime.status = "failed";
        context.runtime.error = asError(error).message;
        // Envelopes held back for the failed turn — from the first await on,
        // not only during turn/start — are answered now, after the reset
        // above, so each is refused as stale rather than left hanging.
        this.replayDeferred(starting);
        if (/(?:not (?:logged|signed) in|auth(?:entication|orization)? required|unauthorized|\b401\b)/i.test(context.runtime.error)) {
          const diagnostic: RuntimeDiagnostic = { code: "auth_required", message: "Codex authentication is required.", detail: context.runtime.error };
          this.appServer.diagnostic = diagnostic;
          this.emit("desktopEvent", { type: "diagnostic", diagnostic } satisfies DesktopEvent);
        }
        this.publish();
        throw error;
      }
    }, assertActive);
  }

  async stopTurn(input: StopTurnInput, assertActive: AssertRequestActive = unscopedRequest): Promise<void> {
    assertActive = this.bindNativeRequest(assertActive);
    assertActive();
    return this.runSessionOperation(input.sessionId, async () => {
      const { session, runtime } = this.context(input.sessionId);
      if (!session.threadId || !runtime.activeTurnId) throw new Error("This session has no active turn");
      const turnId = runtime.activeTurnId;
      const interruptKey = turnKey(input.sessionId, turnId);
      if (this.interruptingTurns.has(interruptKey)) throw new Error("Interrupt has already been requested for this turn");
      this.interruptingTurns.add(interruptKey);
      // Local governed calls are aborted before the server is asked: a slow,
      // hung or failed turn/interrupt must not let a read complete after Stop.
      // The authoritative terminal state still arrives through turn/completed.
      this.cancelToolCalls(input.sessionId, turnId);
      try {
        await this.connection().request("turn/interrupt", { threadId: session.threadId, turnId });
      } catch (error) {
        this.interruptingTurns.delete(interruptKey);
        throw error;
      }
    }, assertActive);
  }

  async respondToRequest(input: RequestResponse, assertActive: AssertRequestActive = unscopedRequest): Promise<void> {
    assertActive = this.bindNativeRequest(assertActive);
    assertActive();
    const key = requestKey(input.requestId);
    const pending = this.pendingById.get(key);
    if (!pending) throw new Error(`Request ${String(input.requestId)} is no longer pending`);
    return this.runSessionOperation(pending.sessionId, async () => {
      const current = this.pendingById.get(key);
      if (!current) throw new Error(`Request ${String(input.requestId)} is no longer pending`);
      const runtime = this.runtimes[current.sessionId];
      try {
        this.connection().respond(input.requestId, responsePayload(current, input));
        this.resolvePending(current, true);
      } catch (error) {
        runtime.error = asError(error).message;
        this.publish();
        throw error;
      }
    }, assertActive);
  }

  async restartCodex(assertActive: AssertRequestActive = unscopedRequest): Promise<void> {
    assertActive();
    this.publishingSuspended = true;
    try {
      this.generation += 1;
      this.starting = null;
      this.clearAllPending();
      this.cancelToolCalls();
      await this.governed?.shutdown?.();
      this.interruptingTurns.clear();
      this.clearCompletionReconciliations();
      this.latestTurnBySession.clear();
      this.contextUsageAwaitingCurrentModel.clear();
      for (const runtime of Object.values(this.runtimes)) {
        const wasActive = runtime.activeTurnId !== null || ["starting", "running", "waiting"].includes(runtime.status);
        runtime.activeTurnId = null;
        for (const item of runtime.messages) item.streaming = false;
        if (wasActive) {
          runtime.status = "failed";
          runtime.error = "Codex app-server restarted; the active turn was interrupted.";
        }
      }
      const previous = this.running;
      this.running = null;
      previous?.connection.close(new Error("Codex app-server restarted"));
      this.starting = null;
      this.joinedThreads.clear();
      this.appServer = { status: "stopped", codexVersion: null, diagnostic: null };
      await this.ensureServer(assertActive);
    } finally {
      this.publishingSuspended = false;
      this.publish();
    }
  }

  shutdown(): Promise<void> {
    this.generation += 1;
    const previous = this.running;
    this.running = null;
    previous?.connection.close(new Error("Orchestrion is shutting down"));
    this.starting = null;
    this.appServer.status = "stopped";
    this.interruptingTurns.clear();
    this.clearCompletionReconciliations();
    this.latestTurnBySession.clear();
    this.contextUsageAwaitingCurrentModel.clear();
    this.clearAllPending();
    this.cancelToolCalls();
    return this.governed?.shutdown?.() ?? Promise.resolve();
  }

  snapshot(): DesktopSnapshot {
    return structuredClone({ appServer: this.appServer, ...this.metadata, runtimes: this.runtimes });
  }

  /** Pin a request to its startup generation and, once available, exact connection.
   * A still-live document never authorizes reuse of a replacement native server. */
  private bindNativeRequest(documentActive: AssertRequestActive): AssertRequestActive {
    const generation = this.generation;
    let connection = this.running?.connection;
    return () => {
      documentActive();
      if (generation !== this.generation || (connection && connection !== this.running?.connection)) {
        throw new Error("Superseded Codex app-server request");
      }
      connection ??= this.running?.connection;
    };
  }

  private async ensureServer(assertActive: AssertRequestActive = unscopedRequest): Promise<void> {
    assertActive = this.bindNativeRequest(assertActive);
    assertActive();
    if (this.running) return;
    if (this.starting) { await this.starting.promise; assertActive(); return; }
    this.appServer = { status: "starting", codexVersion: null, diagnostic: null };
    this.publish();
    const generation = this.generation;
    const starting: StartingCodex = { generation, promise: this.startServer(generation, assertActive) };
    this.starting = starting;
    try {
      await starting.promise;
      assertActive();
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async startServer(generation: number, assertActive: AssertRequestActive): Promise<void> {
    const assertLaunchActive = () => {
      assertActive();
      if (generation !== this.generation) throw new Error("Superseded Codex app-server launch");
    };
    try {
      const running = await this.launch(assertLaunchActive);
      if (generation !== this.generation) {
        running.connection.close(new Error("Superseded Codex app-server launch"));
        throw new Error("Superseded Codex app-server launch");
      }
      try { assertLaunchActive(); } catch (error) { running.connection.close(); throw error; }
      this.running = running;
      running.connection.on("notification", (notification: JsonObject) => this.onNotification(running.connection, notification));
      running.connection.on("serverRequest", (request: JsonObject) => this.onServerRequest(running.connection, request));
      running.connection.on("protocolError", (error: Error) => this.onProtocolError(running.connection, error));
      running.connection.on("exit", (error: Error) => this.onServerExit(running.connection, error));
      this.appServer = { status: "ready", codexVersion: running.version, diagnostic: null };
      this.publish();
    } catch (error) {
      if (generation !== this.generation) throw error;
      const diagnostic = error instanceof CodexLaunchError
        ? error.diagnostic
        : ({ code: "spawn_failed", message: "Codex app-server could not be started.", detail: asError(error).message } satisfies RuntimeDiagnostic);
      this.appServer = { status: "error", codexVersion: null, diagnostic };
      this.emit("desktopEvent", { type: "diagnostic", diagnostic } satisfies DesktopEvent);
      this.publish();
      throw error;
    }
  }

  private connection() {
    if (!this.running) throw new Error("Codex app-server is not ready");
    return this.running.connection;
  }

  private async ensureThread(session: SessionRecord, agent: AgentRecord, project: ProjectRecord, assertActive: AssertRequestActive = unscopedRequest): Promise<string> {
    assertActive();
    if (!session.threadId) {
      // Governed coverage is decided before the thread exists and injected only
      // through thread/start.dynamicTools. An explicit governed binding cannot
      // fall back to a native-only thread when readiness is absent.
      const declaration = this.governed && session.executionMode !== "native"
        ? await this.governed.declare({ sessionId: session.id, agentId: agent.id, projectId: project.id, projectPath: project.path })
        : null;
      if (session.executionMode === "governed" && !declaration)
        throw new GovernedSessionReadinessError();
      let result: JsonObject, threadId: string;
      try {
        // Inside the guarded block: a request revoked after declaration must
        // release the bound attempt exactly like a failed thread/start.
        assertActive();
        result = object(await this.connection().request("thread/start", {
          ...(session.model ? { model: session.model } : {}),
          ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
          ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
          cwd: project.path,
          developerInstructions: agent.instructions || null,
          ...(declaration ? { dynamicTools: declaration.dynamicTools } : {}),
        }));
        // A result that names no thread leaves the session threadless exactly
        // like a failed request, so the bound attempt is released the same way.
        threadId = stringField(object(result.thread), "id");
      } catch (error) {
        if (declaration) this.governed?.release(session.id);
        throw error;
      }
      // The thread and the declaration stay provisional until the session
      // record durably names them. `session` is the live object behind
      // `metadata.sessions`, so a store write failing after it was mutated
      // would leave a same-process retry executing governed reads through a
      // thread and marker nothing persisted, and a restart would strand the
      // bound attempt with no durable session pointing at it. Every field
      // touched below is captured and restored on failure, the attempt is
      // released and the remote thread deleted best-effort, exactly like a
      // failed thread/start.
      const prior = { threadId: session.threadId, governance: session.governance, title: session.title, titleSource: session.titleSource,
        model: session.model, modelProvider: session.modelProvider, reasoningEffort: session.reasoningEffort,
        serviceTier: session.serviceTier, updatedAt: session.updatedAt };
      const hadGovernanceField = "governance" in session;
      try {
        session.threadId = threadId;
        session.governance = declaration
          ? { attemptId: declaration.attemptId, threadId, tools: declaration.tools, declaredAt: new Date().toISOString() }
          : null;
        syncSessionFromThread(session, result);
        if (prior.reasoningEffort) session.reasoningEffort = prior.reasoningEffort;
        if (prior.serviceTier) session.serviceTier = prior.serviceTier;
        session.updatedAt = new Date().toISOString();
        await this.store.updateSession(session);
      } catch (error) {
        Object.assign(session, prior);
        if (!hadGovernanceField) delete session.governance;
        if (declaration) this.governed?.release(session.id);
        try {
          await this.connection().request("thread/delete", { threadId });
        } catch {
          // The local rollback stands whether or not remote cleanup is available; the original error is what surfaces.
        }
        throw error;
      }
      if (prior.model !== session.model || prior.modelProvider !== session.modelProvider) {
        this.selectContextUsageForModel(session, this.runtimes[session.id]);
      }
      assertActive();
      this.threadToSession.set(threadId, session.id);
      this.joinedThreads.add(threadId);
      if (session.titleSource === "manual") {
        assertActive();
        await this.connection().request("thread/name/set", { threadId, name: session.title });
      }
      return threadId;
    }
    this.threadToSession.set(session.threadId, session.id);
    if (!this.joinedThreads.has(session.threadId)) {
      const result = object(await this.connection().request("thread/resume", {
        threadId: session.threadId,
        ...(session.model ? { model: session.model } : {}),
        ...(session.modelProvider ? { modelProvider: session.modelProvider } : {}),
        ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
        cwd: project.path,
        developerInstructions: agent.instructions || null,
      }));
      const requestedEffort = session.reasoningEffort;
      const requestedServiceTier = session.serviceTier;
      const previousModel = session.model;
      const previousProvider = session.modelProvider;
      if (syncSessionFromThread(session, result)) {
        if (previousModel !== session.model || previousProvider !== session.modelProvider) {
          this.selectContextUsageForModel(session, this.runtimes[session.id]);
        }
        if (requestedEffort) session.reasoningEffort = requestedEffort;
        if (requestedServiceTier) session.serviceTier = requestedServiceTier;
        session.updatedAt = new Date().toISOString();
        await this.store.updateSession(session);
      }
      assertActive();
      this.joinedThreads.add(session.threadId);
    }
    return session.threadId;
  }

  private async hydrateHistory(session: SessionRecord): Promise<void> {
    if (!session.threadId || !this.running) return;
    try {
      const result = object(await this.connection().request("thread/read", { threadId: session.threadId, includeTurns: true }));
      const thread = object(result.thread);
      const previousModel = session.model;
      const previousProvider = session.modelProvider;
      if (syncSessionFromThread(session, { thread })) {
        if (previousModel !== session.model || previousProvider !== session.modelProvider) {
          this.selectContextUsageForModel(session, this.runtimes[session.id]);
        }
        session.updatedAt = new Date().toISOString();
        await this.store.updateSession(session);
      }
      const hydrated: ConversationMessage[] = [];
      for (const turn of array(thread.turns)) {
        const turnRecord = object(turn);
        const turnId = optionalString(turnRecord.id) ?? null;
        for (const item of array(turnRecord.items)) {
          const parsed = historyMessage(session.id, object(item), turnId);
          if (parsed) hydrated.push(parsed);
        }
      }
      this.runtimes[session.id].messages = hydrated;
      this.publish();
    } catch (error) {
      this.runtimes[session.id].error = `History could not be restored: ${asError(error).message}`;
      this.publish();
    }
  }

  private onNotification(connection: RunningCodex["connection"], envelope: JsonObject): void {
    if (this.running?.connection !== connection) return;
    const method = String(envelope.method ?? "");
    const params = object(envelope.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;

    if (method === "serverRequest/resolved") {
      const requestId = params.requestId as RequestId;
      const pending = this.pendingById.get(requestKey(requestId));
      if (pending) this.resolvePending(pending, true);
      return;
    }
    if (!sessionId) return;
    const runtime = this.runtimes[sessionId];
    const session = this.metadata.sessions.find((candidate) => candidate.id === sessionId);

    if (method === "thread/name/updated" && session) {
      const title = optionalString(params.threadName);
      if (title && title !== session.title) {
        session.title = title;
        session.titleSource = "codex";
        session.updatedAt = new Date().toISOString();
        this.persistNotificationSession(session);
      }
      this.publish();
      return;
    }
    if (method === "thread/settings/updated" && session) {
      const previousModel = session.model;
      const previousProvider = session.modelProvider;
      if (syncSessionFromSettings(session, object(params.threadSettings))) {
        if (previousModel !== session.model || previousProvider !== session.modelProvider) {
          this.selectContextUsageForModel(session, runtime);
        }
        session.updatedAt = new Date().toISOString();
        this.persistNotificationSession(session);
      }
      this.publish();
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      const usage = contextWindowUsageFromNotification(params);
      if (!usage || !session) return;
      const latestTurnId = this.latestTurnBySession.get(sessionId);
      if (latestTurnId && usage.turnId !== latestTurnId) return;
      if (this.contextUsageAwaitingCurrentModel.has(sessionId)) {
        if (runtime.activeTurnId !== usage.turnId) return;
        this.contextUsageAwaitingCurrentModel.delete(sessionId);
      }
      this.latestTurnBySession.set(sessionId, usage.turnId);
      this.latestContextUsageBySession.set(sessionId, usage);
      const windows = this.contextWindowBySessionModel.get(sessionId) ?? new Map<string, number | null>();
      windows.set(contextModelKey(session), usage.contextWindowTokens);
      this.contextWindowBySessionModel.set(sessionId, windows);
      runtime.contextWindowUsage = usage;
      this.publish();
      return;
    }

    if (method === "turn/started") {
      const turnId = stringField(object(params.turn), "id");
      // While this session's turn/start is in flight and no turn is active, a
      // null activeTurnId and a "starting" status are exactly what that request
      // left behind, whichever turn this notification names: the id cannot be
      // told from a late or duplicate turn/started for a turn that finished
      // before the request was sent, and promoting such an id would admit
      // governed calls for a finished turn and leave the continuation, which
      // promotes only from a null activeTurnId, unable to name the real one.
      // The notification is held like every other turn-scoped envelope and
      // replayed once the continuation has settled the turn: naming the turn
      // it confirmed, the guards below let it through as a no-op; naming any
      // other, or a turn retired or failed meanwhile, they discard it.
      if (this.deferWhileStarting(sessionId, runtime, { kind: "notification", key: null, connection, envelope })) return;
      if (runtime.activeTurnId !== null && runtime.activeTurnId !== turnId) return;
      if (runtime.activeTurnId === null && runtime.status !== "starting"
        && !(runtime.status === "waiting" && runtime.pendingRequests.some((pending) => pending.turnId === turnId))) return;
      this.latestTurnBySession.set(sessionId, turnId);
      // A turn/completed for this very turn may already be waiting in
      // `startingTurns` (delivered in the same chunk, ahead of this notification
      // and of the turn/start continuation). Promoting it would admit governed
      // calls for a finished turn and leave the continuation, which promotes
      // only from a null activeTurnId, unable to apply the buffered completion:
      // the runtime would stay "running" forever. It is retired here instead.
      // With the hold above, this notification normally reaches this point
      // only after the continuation has consumed that record; the check stays
      // so that whichever of the two runs first retires the turn exactly once.
      if (!this.retireIfCompletedEarly(sessionId, runtime, turnId)) {
        runtime.activeTurnId = turnId;
        runtime.status = runtime.pendingRequests.length ? "waiting" : "running";
      }
    } else if (method === "item/agentMessage/delta") {
      if (!isFreshTurn(runtime, params)) { this.deferWhileStarting(sessionId, runtime, { kind: "notification", key: null, connection, envelope }); return; }
      const itemId = stringField(params, "itemId");
      let target = runtime.messages.find((entry) => entry.id === itemId);
      if (!target) {
        target = message(sessionId, "assistant", "", null, itemId, undefined, optionalString(params.turnId) ?? runtime.activeTurnId);
        target.streaming = true;
        runtime.messages.push(target);
      }
      target.text += String(params.delta ?? "");
      target.streaming = true;
      target.turnId = optionalString(params.turnId) ?? target.turnId ?? runtime.activeTurnId;
    } else if (method === "item/reasoning/summaryTextDelta") {
      if (!isFreshTurn(runtime, params)) { this.deferWhileStarting(sessionId, runtime, { kind: "notification", key: null, connection, envelope }); return; }
      const itemId = stringField(params, "itemId");
      let target = runtime.messages.find((entry) => entry.id === itemId);
      if (!target) {
        const activity = activityFromItem({ type: "reasoning" }, false)!;
        target = message(sessionId, "system", activityText(activity), null, itemId, undefined, optionalString(params.turnId) ?? runtime.activeTurnId);
        target.activity = activity;
        target.streaming = true;
        runtime.messages.push(target);
      }
      if (target.activity) target.activity = appendReasoningSummary(target.activity, params.delta);
    } else if (method === "item/commandExecution/outputDelta") {
      if (!isFreshTurn(runtime, params)) { this.deferWhileStarting(sessionId, runtime, { kind: "notification", key: null, connection, envelope }); return; }
      const itemId = stringField(params, "itemId");
      let target = runtime.messages.find((entry) => entry.id === itemId);
      if (!target) {
        const activity = activityFromItem({ type: "commandExecution" }, false)!;
        target = message(sessionId, "system", activityText(activity), null, itemId, undefined, optionalString(params.turnId) ?? runtime.activeTurnId);
        target.activity = activity;
        target.streaming = true;
        runtime.messages.push(target);
      }
      if (target.activity) target.activity = appendActivityOutput(target.activity, params.delta);
    } else if (method === "item/started" || method === "item/completed") {
      if (!isFreshTurn(runtime, params)) { this.deferWhileStarting(sessionId, runtime, { kind: "notification", key: null, connection, envelope }); return; }
      const item = object(params.item);
      const completed = method === "item/completed";
      const turnId = optionalString(params.turnId) ?? runtime.activeTurnId;
      this.applyItem(sessionId, item, completed, turnId);
      if (completed && item.type === "agentMessage" && item.phase === "final_answer" && turnId) {
        this.scheduleCompletionReconciliation(sessionId, turnId);
      }
    } else if (method === "thread/compact/start") {
      if (!isFreshTurn(runtime, params)) { this.deferWhileStarting(sessionId, runtime, { kind: "notification", key: null, connection, envelope }); return; }
      const turnId = optionalString(params.turnId) ?? runtime.activeTurnId;
      const id = `context-compaction:${turnId ?? "thread"}`;
      if (!runtime.messages.some((entry) => entry.id === id)) {
        const activity = activityFromItem({ type: "contextCompaction" }, false)!;
        const entry = message(sessionId, "system", activityText(activity), null, id, undefined, turnId);
        entry.activity = activity;
        entry.streaming = true;
        runtime.messages.push(entry);
      }
    } else if (method === "turn/completed") {
      const turn = object(params.turn);
      const turnId = stringField(turn, "id");
      if (runtime.activeTurnId !== turnId) {
        // Not active yet because the turn/start result naming it is still
        // being delivered: keep the completion for that result's continuation.
        this.startingTurns.get(sessionId)?.completedEarly.set(turnId, turn);
        return;
      }
      this.completeTurn(sessionId, runtime, turnId, turn);
    } else if (method === "error") {
      if (!isFreshTurn(runtime, params)) { this.deferWhileStarting(sessionId, runtime, { kind: "notification", key: null, connection, envelope }); return; }
      runtime.error = errorText(params.error);
      if (params.willRetry !== true) {
        runtime.status = "failed";
        if (runtime.activeTurnId) this.clearPendingForTurn(sessionId, runtime.activeTurnId);
        runtime.activeTurnId = null;
      }
    }
    this.publish();
  }

  /** The one path that retires a turn whose `turn/completed` was buffered in
   * `startingTurns` before anything recognised the turn as active. Both places
   * that would otherwise promote such a turn — the `turn/start` continuation
   * and the `turn/started` notification — call this first; whichever runs
   * first consumes the buffered completion, so the other finds nothing and
   * the turn is retired exactly once. Returns true when the turn was retired
   * and therefore must not be promoted. */
  private retireIfCompletedEarly(sessionId: string, runtime: SessionRuntime, turnId: string,
    completedEarly: Map<string, JsonObject> | undefined = this.startingTurns.get(sessionId)?.completedEarly): boolean {
    const completed = completedEarly?.get(turnId);
    if (!completed) return false;
    completedEarly?.delete(turnId);
    this.completeTurn(sessionId, runtime, turnId, completed);
    return true;
  }

  /** Retire the active turn as `turn/completed` reports it: governed calls
   * aborted, pending requests resolved, the interrupt key released and the
   * terminal status applied. Shared by the notification and, through
   * `retireIfCompletedEarly`, by the `turn/start` continuation and the
   * `turn/started` notification when the turn completed before either
   * recognised it. */
  private completeTurn(sessionId: string, runtime: SessionRuntime, turnId: string, turn: JsonObject): void {
    this.cancelCompletionReconciliation(sessionId, turnId);
    this.clearPendingForTurn(sessionId, turnId);
    this.interruptingTurns.delete(turnKey(sessionId, turnId));
    runtime.activeTurnId = null;
    if (turn.status === "failed") {
      runtime.status = "failed";
      runtime.error = errorText(turn.error);
    } else if (turn.status === "interrupted") {
      runtime.status = "idle";
      runtime.error = "Turn interrupted.";
      runtime.messages.push(message(sessionId, "system", "Turn interrupted.", null, `turn-${turnId}-interrupted`, undefined, turnId));
    } else {
      runtime.status = "idle";
      runtime.error = null;
    }
    for (const item of runtime.messages) {
      item.streaming = false;
      if (item.turnId === turnId && item.activity?.status === "running") {
        item.activity = { ...item.activity, status: "completed" };
        item.text = activityText(item.activity);
      }
    }
  }

  private scheduleCompletionReconciliation(sessionId: string, turnId: string, attempt = 0): void {
    if (attempt >= TURN_COMPLETION_RECONCILE_DELAYS_MS.length) return;
    this.cancelCompletionReconciliation(sessionId);
    const timer = setTimeout(() => {
      const current = this.completionReconciliations.get(sessionId);
      if (!current || current.turnId !== turnId || current.timer !== timer) return;
      this.completionReconciliations.delete(sessionId);
      void this.reconcileTurnCompletion(sessionId, turnId, attempt);
    }, TURN_COMPLETION_RECONCILE_DELAYS_MS[attempt]);
    this.completionReconciliations.set(sessionId, { turnId, timer });
  }

  private async reconcileTurnCompletion(sessionId: string, turnId: string, attempt: number): Promise<void> {
    const session = this.metadata.sessions.find((candidate) => candidate.id === sessionId);
    const runtime = this.runtimes[sessionId];
    const connection = this.running?.connection;
    const generation = this.generation;
    if (!session?.threadId || !runtime || !connection || runtime.activeTurnId !== turnId) return;

    try {
      const result = object(await connection.request("thread/read", { threadId: session.threadId, includeTurns: true }));
      if (generation !== this.generation || connection !== this.running?.connection || runtime.activeTurnId !== turnId) return;
      const turn = array(object(result.thread).turns).map(object).find((candidate) => candidate.id === turnId);
      if (turn && TERMINAL_TURN_STATUSES.has(String(turn.status ?? ""))) {
        this.completeTurn(sessionId, runtime, turnId, turn);
        this.publish();
        return;
      }
    } catch {
      // This is a recovery path. A transient read failure must not replace the
      // live turn state or surface a misleading conversation error.
    }

    if (runtime.activeTurnId === turnId) this.scheduleCompletionReconciliation(sessionId, turnId, attempt + 1);
  }

  private cancelCompletionReconciliation(sessionId: string, turnId?: string): void {
    const current = this.completionReconciliations.get(sessionId);
    if (!current || (turnId !== undefined && current.turnId !== turnId)) return;
    clearTimeout(current.timer);
    this.completionReconciliations.delete(sessionId);
  }

  private clearCompletionReconciliations(): void {
    for (const current of this.completionReconciliations.values()) clearTimeout(current.timer);
    this.completionReconciliations.clear();
  }

  /** Hold back a turn-scoped envelope that names a turn while its session's
   * `turn/start` is in flight and no turn is active yet. Whether the named
   * turn is the one the pending result is about to confirm or a replay from
   * an earlier turn cannot be known until the continuation reads that result,
   * so the envelope is neither admitted — no id is ever accepted on
   * speculation — nor refused; `replayDeferred` re-dispatches it once the
   * turn is settled. It is held only while the continuation could still
   * promote the turn it reads, which is the continuation's own predicate:
   * once a notification has already settled the session (a named turn is
   * active, or the turn was retired or failed before being promoted) the
   * envelope is judged at once, exactly as before. Only an envelope that
   * names a turn is ever held, and each caller establishes that itself since
   * the shapes differ: item and server-request envelopes carry the id as
   * `params.turnId` and call this only after `isFreshTurn` has refused it
   * (an envelope carrying no id is never refused there); `turn/started`
   * carries it as `params.turn.id`, required, and calls this ahead of its own
   * guards, which a stale id would otherwise satisfy by timing alone.
   * Returns true when the envelope was held. */
  private deferWhileStarting(sessionId: string, runtime: SessionRuntime, entry: DeferredEnvelope): boolean {
    const starting = this.startingTurns.get(sessionId);
    if (!starting || runtime.activeTurnId !== null || !["starting", "waiting"].includes(runtime.status)) return false;
    starting.deferred.push(entry);
    return true;
  }

  /** Re-dispatch, in arrival order, the envelopes a session held back while
   * its `turn/start` was in flight, once the continuation has settled the
   * turn. The record is already unregistered, so nothing is held again, and
   * each envelope meets exactly the judgement it would have met had it
   * arrived after the turn was named: admitted when it names the active turn,
   * refused as stale otherwise — including when the request failed or the
   * turn was retired before being promoted. An envelope from a connection
   * that has since been replaced is dropped: nothing can answer it. */
  private replayDeferred(starting: StartingTurn): void {
    for (const entry of starting.deferred.splice(0)) {
      if (this.running?.connection !== entry.connection) continue;
      if (entry.kind === "serverRequest") this.dispatchServerRequest(entry.connection, entry.envelope);
      else this.onNotification(entry.connection, entry.envelope);
    }
  }

  private persistNotificationSession(session: SessionRecord): void {
    void this.store.updateSession(structuredClone(session)).catch((error) => {
      const runtime = this.runtimes[session.id];
      if (runtime) runtime.error = `Session metadata could not be saved: ${asError(error).message}`;
      this.publish();
    });
  }

  private applyItem(sessionId: string, item: JsonObject, completed: boolean, turnId: string | null): void {
    const runtime = this.runtimes[sessionId];
    const id = stringField(item, "id");
    const type = String(item.type ?? "");
    if (type === "agentMessage") {
      let target = runtime.messages.find((entry) => entry.id === id);
      if (!target) {
        target = message(sessionId, "assistant", String(item.text ?? ""), phase(item.phase), id, undefined, turnId);
        runtime.messages.push(target);
      } else if (completed && typeof item.text === "string") {
        target.text = item.text;
        target.phase = phase(item.phase);
      }
      target.streaming = !completed;
      target.turnId = turnId;
      return;
    }
    if (type === "userMessage") return;
    const activity = activityFromItem(item, completed);
    if (!activity) return;
    const summary = activityText(activity);
    const existing = runtime.messages.find((entry) => entry.id === id);
    if (existing) {
      const priorActivity = existing.activity;
      existing.text = summary;
      existing.streaming = !completed;
      existing.activity = {
        ...activity,
        ...(!activity.arguments && priorActivity?.arguments ? { arguments: priorActivity.arguments } : {}),
        ...(!activity.result && priorActivity?.result ? { result: priorActivity.result } : {}),
      };
      existing.turnId = turnId;
    } else {
      const entry = message(sessionId, "system", summary, null, id, undefined, turnId);
      entry.streaming = !completed;
      entry.activity = activity;
      runtime.messages.push(entry);
    }
  }

  private onServerRequest(connection: RunningCodex["connection"], envelope: JsonObject): void {
    if (this.running?.connection !== connection) return;
    if (!this.claimRequestId(requestKey(envelope.id as RequestId))) return;
    this.dispatchServerRequest(connection, envelope);
  }

  /** Every server request claims its JSON-RPC id here, once, on arrival, ahead
   * of every branch that could answer it — admission, refusal or protocol
   * rejection, for `item/tool/call` and renderer-facing methods alike. An id
   * may belong to a pending request in `pendingById`, to a governed call in
   * `toolCalls`, or to a request held back in `startingTurns` until its turn
   * is settled, and each of those is answered by its own settlement; a
   * request that replays an id any of them still owns is therefore ignored
   * outright (no response, no map or host work) so the owner's settlement
   * stays the only answer the id ever receives, whichever method either
   * request carries. A cancelled call still settling under the id loses the
   * right to answer here, so its late result is never delivered under an id
   * the newer request now owns. Returns false when the id is live and the
   * request must be ignored. */
  private claimRequestId(key: string): boolean {
    if (this.pendingById.has(key) || this.toolCalls.has(key)) return false;
    for (const starting of this.startingTurns.values()) if (starting.deferred.some((entry) => entry.key === key)) return false;
    const predecessor = this.cancelledToolCalls.get(key);
    if (predecessor) { predecessor.superseded = true; this.cancelledToolCalls.delete(key); }
    return true;
  }

  private dispatchServerRequest(connection: RunningCodex["connection"], envelope: JsonObject): void {
    if (envelope.method === "item/tool/call") { this.onToolCall(connection, envelope); return; }
    const method = String(envelope.method ?? "") as PendingRequest["method"];
    if (!isSupportedServerRequest(method)) {
      this.connection().reject(envelope.id as RequestId, -32601, `Unsupported server request: ${method}`);
      return;
    }
    const params = object(envelope.params);
    let threadId: string;
    try {
      threadId = stringField(params, "threadId");
    } catch (error) {
      this.connection().reject(envelope.id as RequestId, -32602, asError(error).message);
      return;
    }
    const sessionId = this.threadToSession.get(threadId);
    if (!sessionId) {
      this.connection().reject(envelope.id as RequestId, -32602, `No session is mapped to thread ${threadId}`);
      return;
    }
    const runtime = this.runtimes[sessionId];
    if (!isFreshTurn(runtime, params)) {
      if (this.deferWhileStarting(sessionId, runtime, { kind: "serverRequest", key: requestKey(envelope.id as RequestId), connection, envelope })) return;
      this.connection().reject(envelope.id as RequestId, -32602, "Server request belongs to a stale turn");
      return;
    }
    let pending: PendingRequest;
    try {
      pending = pendingRequest(envelope.id as RequestId, sessionId, method, params);
    } catch (error) {
      this.connection().reject(envelope.id as RequestId, -32602, asError(error).message);
      return;
    }
    this.pendingById.set(requestKey(pending.requestId), pending);
    runtime.pendingRequests.push(pending);
    runtime.status = "waiting";
    this.publish();
  }

  /** Governed dynamic tool call. Host-executed and answered directly: it is never a
   * renderer-facing pending request and never an approval. Everything the host
   * decides is redacted to a closed code; the native shell/file/approval lanes
   * are untouched by this path. */
  private onToolCall(connection: RunningCodex["connection"], envelope: JsonObject): void {
    const id = envelope.id as RequestId;
    // The id was claimed on arrival (`claimRequestId`): no live call or pending
    // request owns it and any cancelled predecessor is already superseded.
    const key = requestKey(id);
    const params = object(envelope.params);
    const threadId = optionalString(params.threadId);
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
    if (!threadId || !sessionId) {
      this.connection().reject(id, -32602, threadId ? `No session is mapped to thread ${threadId}` : "Protocol field threadId must be a non-empty string");
      return;
    }
    const runtime = this.runtimes[sessionId];
    const respond = (response: DynamicToolCallResponse) => {
      if (this.running?.connection !== connection) return;
      try { connection.respond(id, response); } catch { /* the server is gone; the durable event already records the outcome */ }
    };
    if (!isFreshTurn(runtime, params)) {
      if (this.deferWhileStarting(sessionId, runtime, { kind: "serverRequest", key, connection, envelope })) return;
      respond(governedRefusal(GOVERNED_TOOL_REASONS.staleTurn)); return;
    }
    if (!this.governed) { respond(governedRefusal(GOVERNED_TOOL_REASONS.hostUnavailable)); return; }
    // Stop and Delete are decided locally before the server answers. Until
    // turn/completed retires the turn or the session record is gone, both stay
    // nominally live; nothing new is admitted for them in that window.
    const turnId = optionalString(params.turnId) ?? runtime.activeTurnId;
    if (this.deletingSessions.has(sessionId) || (turnId !== null && this.interruptingTurns.has(turnKey(sessionId, turnId)))) {
      respond(governedRefusal(GOVERNED_TOOL_REASONS.cancelled)); return;
    }
    const session = this.metadata.sessions.find((candidate) => candidate.id === sessionId);
    const controller = new AbortController();
    const entry: ToolCallEntry = { sessionId, turnId: optionalString(params.turnId) ?? null, controller, superseded: false };
    this.toolCalls.set(key, entry);
    const executing = this.governed.execute({ sessionId, governance: session?.governance ?? null, call: params, signal: controller.signal })
      .then((response) => response, () => governedRefusal(GOVERNED_TOOL_REASONS.hostUnavailable));
    // The deadline wins only when the host has not settled; then the call is
    // aborted (the host records `cancelled` if it ever wakes) and answered closed.
    // A host that settles first clears the timer and is answered unchanged.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<DynamicToolCallResponse>((resolve) => {
      deadline = setTimeout(() => { controller.abort(); resolve(governedRefusal(GOVERNED_TOOL_REASONS.timedOut)); }, GOVERNED_TOOL_CALL_DEADLINE_MS);
      deadline.unref?.();
    });
    void Promise.race([executing, expired])
      .then((response) => {
        clearTimeout(deadline);
        // JSON-RPC ids restart with a new app-server connection. A call aborted by a
        // restart can settle after a newer call reused its id; it must only clear
        // its own entry, never the newer call's controller.
        if (this.toolCalls.get(key) === entry) this.toolCalls.delete(key);
        if (this.cancelledToolCalls.get(key) === entry) this.cancelledToolCalls.delete(key);
        // A cancelled call is still answered (the server's request is outstanding)
        // unless a newer call has taken over its id: then its stale result must
        // never be delivered under that id.
        if (entry.superseded) return;
        respond(response);
      });
  }

  private cancelToolCalls(sessionId?: string, turnId?: string): void {
    for (const [key, call] of this.toolCalls) {
      if (sessionId !== undefined && call.sessionId !== sessionId) continue;
      if (turnId !== undefined && call.turnId !== null && call.turnId !== turnId) continue;
      this.toolCalls.delete(key);
      this.cancelledToolCalls.set(key, call);
      call.controller.abort();
    }
  }

  private onProtocolError(connection: RunningCodex["connection"], error: Error): void {
    if (this.running?.connection !== connection) return;
    const diagnostic: RuntimeDiagnostic = { code: "protocol_error", message: "Codex app-server sent an invalid protocol message.", detail: error.message };
    this.appServer.diagnostic = diagnostic;
    this.emit("desktopEvent", { type: "diagnostic", diagnostic } satisfies DesktopEvent);
    this.publish();
  }

  private onServerExit(connection: RunningCodex["connection"], error: Error): void {
    if (this.running?.connection !== connection) return;
    this.running = null;
    this.joinedThreads.clear();
    const diagnostic: RuntimeDiagnostic = { code: "server_exited", message: "Codex app-server exited unexpectedly.", detail: error.message };
    this.appServer = { ...this.appServer, status: "error", diagnostic };
    for (const runtime of Object.values(this.runtimes)) {
      if (runtime.status !== "idle") runtime.status = "failed";
      runtime.activeTurnId = null;
      runtime.error = diagnostic.message;
      for (const item of runtime.messages) item.streaming = false;
    }
    this.interruptingTurns.clear();
    this.clearCompletionReconciliations();
    this.latestTurnBySession.clear();
    this.contextUsageAwaitingCurrentModel.clear();
    this.clearAllPending();
    this.cancelToolCalls();
    void this.governed?.shutdown?.();
    this.emit("desktopEvent", { type: "diagnostic", diagnostic } satisfies DesktopEvent);
    this.publish();
  }

  private clearPendingForTurn(sessionId: string, turnId: string): void {
    this.cancelToolCalls(sessionId, turnId);
    for (const pending of [...this.pendingById.values()]) {
      if (pending.sessionId === sessionId && (pending.turnId === turnId || pending.turnId === null)) this.resolvePending(pending, true);
    }
  }

  private clearAllPending(): void {
    for (const pending of [...this.pendingById.values()]) this.resolvePending(pending, false);
  }

  private resolvePending(pending: PendingRequest, emitResolved: boolean): void {
    this.pendingById.delete(requestKey(pending.requestId));
    const runtime = this.runtimes[pending.sessionId];
    runtime.pendingRequests = runtime.pendingRequests.filter((candidate) => requestKey(candidate.requestId) !== requestKey(pending.requestId));
    if (runtime.status === "waiting") runtime.status = runtime.activeTurnId ? "running" : "idle";
    if (emitResolved) this.emit("desktopEvent", { type: "request-resolved", requestId: pending.requestId, sessionId: pending.sessionId } satisfies DesktopEvent);
    this.publish();
  }

  private selectContextUsageForModel(session: SessionRecord, runtime: SessionRuntime): void {
    if (runtime.contextWindowUsage) this.latestContextUsageBySession.set(session.id, runtime.contextWindowUsage);
    const windows = this.contextWindowBySessionModel.get(session.id);
    const key = contextModelKey(session);
    const latest = this.latestContextUsageBySession.get(session.id);
    if (latest && windows?.has(key)) {
      runtime.contextWindowUsage = { ...latest, contextWindowTokens: windows.get(key) ?? null };
      this.contextUsageAwaitingCurrentModel.add(session.id);
      return;
    }
    runtime.contextWindowUsage = null;
    this.contextUsageAwaitingCurrentModel.add(session.id);
  }

  private context(sessionId: string): { session: SessionRecord; runtime: SessionRuntime; agent: AgentRecord; project: ProjectRecord } {
    const session = this.metadata.sessions.find((record) => record.id === sessionId);
    if (!session) throw new Error("Session not found");
    const agent = this.metadata.agents.find((record) => record.id === session.agentId);
    if (!agent) throw new Error("Agent not found");
    const project = this.metadata.projects.find((record) => record.id === agent.projectId);
    if (!project) throw new Error("Project not found");
    return { session, runtime: this.runtimes[session.id] ??= EMPTY_RUNTIME(), agent, project };
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>, assertActive: AssertRequestActive = unscopedRequest): Promise<T> {
    const previous = this.sessionOperations.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.sessionOperations.set(sessionId, queued);
    await previous;
    try {
      assertActive();
      return await operation();
    } finally {
      release();
      if (this.sessionOperations.get(sessionId) === queued) this.sessionOperations.delete(sessionId);
    }
  }

  private publish(): void {
    if (this.publishingSuspended) return;
    this.emit("desktopEvent", { type: "snapshot", snapshot: this.snapshot() } satisfies DesktopEvent);
  }
}

function pendingRequest(id: RequestId, sessionId: string, method: PendingRequest["method"], params: JsonObject): PendingRequest {
  const requested = object(params.permissions);
  const questions = array(params.questions).map((question) => {
    const value = object(question);
    return {
      id: stringField(value, "id"), header: optionalString(value.header), question: String(value.question ?? ""),
      options: Array.isArray(value.options) ? value.options.map((option) => ({ label: String(object(option).label ?? ""), description: optionalString(object(option).description) })) : undefined,
      isOther: value.isOther === true, isSecret: value.isSecret === true,
    };
  });
  const mode = optionalString(params.mode);
  const availableDecisions = parseAvailableDecisions(params, method);
  const elicitation = method === "mcpServer/elicitation/request" ? parseElicitationRequest(params, mode) : undefined;
  return {
    requestId: id, sessionId, threadId: stringField(params, "threadId"), turnId: optionalString(params.turnId) ?? null, itemId: optionalString(params.itemId) ?? null, method,
    title: requestTitle(method, params), detail: requestDetail(method, params, mode), command: optionalString(params.command), cwd: optionalString(params.cwd),
    questions: questions.length ? questions : undefined,
    availableDecisions,
    requestedPermissions: Object.keys(requested).length ? { network: nullableObject(requested.network), fileSystem: nullableObject(requested.fileSystem) } : undefined,
    elicitation,
    createdAt: new Date().toISOString(),
  };
}

function responsePayload(pending: PendingRequest, response: RequestResponse): JsonObject {
  if ((pending.method === "item/commandExecution/requestApproval" || pending.method === "item/fileChange/requestApproval") && response.kind === "approval") {
    if (!approvalDecisionAllowed(pending, response.decision)) throw new Error("That approval decision was not offered by Codex");
    return { decision: response.decision };
  }
  if (pending.method === "item/tool/requestUserInput" && response.kind === "userInput") return { answers: response.answers };
  if (pending.method === "item/permissions/requestApproval" && response.kind === "permissions") return { permissions: response.permissions, scope: response.scope ?? "turn" };
  if (pending.method === "mcpServer/elicitation/request" && response.kind === "elicitation") {
    if (response.action === "accept" && !validateElicitationContent(pending, response.content)) throw new Error("The elicitation response does not match the requested schema or mode");
    if (response.action !== "accept" && response.content !== null) throw new Error("Declined or cancelled elicitations must not include content");
    return { action: response.action, content: response.content, _meta: null };
  }
  throw new Error(`Response kind ${response.kind} does not match ${pending.method}`);
}

function parseAvailableDecisions(params: JsonObject, method: PendingRequest["method"]): ApprovalDecision[] | undefined {
  if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") return undefined;
  if (!("availableDecisions" in params)) return undefined;
  if (!Array.isArray(params.availableDecisions)) throw new Error("Protocol field availableDecisions must be an array when present");
  return params.availableDecisions.map((value) => parseApprovalDecision(value, method));
}

function parseApprovalDecision(value: unknown, method: PendingRequest["method"]): ApprovalDecision {
  if (value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel") return value;
  if (method === "item/fileChange/requestApproval") throw new Error("File approval includes an unsupported decision");
  const record = object(value);
  if (isExactKey(record, "acceptWithExecpolicyAmendment")) {
    const amendment = object(record.acceptWithExecpolicyAmendment);
    if (!isExactKey(amendment, "execpolicy_amendment") || !Array.isArray(amendment.execpolicy_amendment) || amendment.execpolicy_amendment.some((token) => typeof token !== "string")) {
      throw new Error("Command approval includes an invalid exec-policy decision");
    }
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...amendment.execpolicy_amendment] as string[] } };
  }
  if (isExactKey(record, "applyNetworkPolicyAmendment")) {
    const wrapper = object(record.applyNetworkPolicyAmendment);
    const amendment = object(wrapper.network_policy_amendment);
    if (!isExactKey(wrapper, "network_policy_amendment") || typeof amendment.host !== "string" || !amendment.host || (amendment.action !== "allow" && amendment.action !== "deny")) {
      throw new Error("Command approval includes an invalid network-policy decision");
    }
    return { applyNetworkPolicyAmendment: { network_policy_amendment: { host: amendment.host, action: amendment.action } } };
  }
  throw new Error("Command approval includes an unsupported decision");
}

function parseElicitationRequest(params: JsonObject, mode?: string): McpElicitationRequest {
  if (mode !== "form" && mode !== "openai/form" && mode !== "openaiForm" && mode !== "url") {
    throw new Error("Protocol field mode contains an unsupported MCP elicitation mode");
  }
  const common = {
    mode,
    serverName: stringField(params, "serverName"),
    message: stringField(params, "message"),
  } satisfies Pick<McpElicitationRequest, "mode" | "serverName" | "message">;
  if (mode === "url") {
    return { ...common, url: stringField(params, "url"), elicitationId: stringField(params, "elicitationId") };
  }
  if (!("requestedSchema" in params)) throw new Error("MCP form elicitation is missing requestedSchema");
  return { ...common, requestedSchema: structuredClone(params.requestedSchema) };
}

function isExactKey(value: JsonObject, key: string): boolean {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === key;
}

function historyMessage(sessionId: string, item: JsonObject, turnId: string | null): ConversationMessage | null {
  const id = stringField(item, "id");
  if (item.type === "agentMessage") return message(sessionId, "assistant", String(item.text ?? ""), phase(item.phase), id, undefined, turnId);
  if (item.type === "userMessage") {
    const content = array(item.content).map(object);
    const text = content.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("\n");
    const attachments = content.flatMap((part, index): ComposerAttachment[] => {
      if (part.type !== "localImage" && part.type !== "localAudio" && part.type !== "mention") return [];
      const path = optionalString(part.path);
      if (!path) return [];
      return [{
        id: `${id}:attachment:${index}`,
        path,
        name: optionalString(part.name) ?? basename(path),
        kind: part.type === "localImage" ? "image" : part.type === "localAudio" ? "audio" : "file",
        mimeType: null,
        size: null,
        previewUrl: null,
      }];
    });
    return text || attachments.length ? message(sessionId, "user", text, null, id, attachments, turnId) : null;
  }
  const activity = activityFromItem(item, true);
  if (!activity) return null;
  const entry = message(sessionId, "system", activityText(activity), null, id, undefined, turnId);
  entry.activity = activity;
  return entry;
}

function requestTitle(method: PendingRequest["method"], params: JsonObject): string {
  if (method === "item/commandExecution/requestApproval") return "Approve command";
  if (method === "item/fileChange/requestApproval") return "Approve file changes";
  if (method === "item/tool/requestUserInput") return "Codex needs your input";
  if (method === "item/permissions/requestApproval") return "Approve additional permissions";
  return optionalString(params.title) ?? `Input requested by ${String(params.serverName ?? "MCP server")}`;
}

function requestDetail(method: PendingRequest["method"], params: JsonObject, mode?: string): string {
  if (method === "mcpServer/elicitation/request") return optionalString(params.description) ?? optionalString(params.message) ?? (mode === "url" ? String(params.url ?? "") : "An MCP server requested input.");
  return optionalString(params.reason) ?? optionalString(params.command) ?? "Review this request before Codex continues.";
}

function isSupportedServerRequest(value: string): value is PendingRequest["method"] {
  return ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "item/permissions/requestApproval", "mcpServer/elicitation/request"].includes(value);
}

function message(sessionId: string, role: ConversationMessage["role"], text: string, itemPhase: ConversationMessage["phase"], id: string = randomUUID(), attachments?: ComposerAttachment[], turnId?: string | null): ConversationMessage {
  return { id, sessionId, role, text, phase: itemPhase, createdAt: new Date().toISOString(), streaming: false, ...(turnId !== undefined ? { turnId } : {}), ...(attachments?.length ? { attachments: structuredClone(attachments) } : {}) };
}

function provisionalSessionTitle(text: string, attachments: ComposerAttachment[]): string {
  const source = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? attachments[0]?.name ?? "New session";
  const collapsed = source.replace(/\s+/g, " ");
  return collapsed.length <= 54 ? collapsed : `${collapsed.slice(0, 53).trimEnd()}…`;
}

function normalizedAttachments(value: ComposerAttachment[] | undefined): ComposerAttachment[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const attachments = value.filter((attachment) => {
    if (!attachment || typeof attachment.path !== "string" || !attachment.path || seen.has(attachment.path)) return false;
    if (!["image", "audio", "file", "folder"].includes(attachment.kind)) return false;
    seen.add(attachment.path);
    return true;
  });
  if (attachments.length > 32) throw new Error("A message can include up to 32 attachments");
  return attachments.map((attachment) => ({ ...attachment, previewUrl: null }));
}

function turnInputs(text: string, attachments: ComposerAttachment[]): JsonObject[] {
  const inputs: JsonObject[] = text ? [{ type: "text", text, text_elements: [] }] : [];
  for (const attachment of attachments) {
    if (attachment.kind === "image") inputs.push({ type: "localImage", path: attachment.path });
    else if (attachment.kind === "audio") inputs.push({ type: "localAudio", path: attachment.path });
    else inputs.push({ type: "mention", name: attachment.name, path: attachment.path });
  }
  return inputs;
}

function phase(value: unknown): ConversationMessage["phase"] {
  return value === "commentary" || value === "final_answer" ? value : null;
}

function errorText(value: unknown): string {
  const record = object(value);
  return optionalString(record.message) ?? "Codex turn failed";
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function nullableObject(value: unknown): JsonObject | undefined {
  const parsed = object(value);
  return Object.keys(parsed).length ? parsed : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(value: JsonObject, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error(`Protocol field ${key} must be a non-empty string`);
  return field;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function normalizedOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function workspaceFileRequest(input: ReadWorkspaceFileInput): { sessionId: string; relativePath: string } {
  if (!input || typeof input !== "object") throw new Error("Workspace file request is required");
  if (typeof input.sessionId !== "string") throw new Error("Session id is required");
  if (typeof input.relativePath !== "string") throw new Error("Workspace path must be a string");
  return { sessionId: requiredText(input.sessionId, "Session id"), relativePath: input.relativePath };
}

function modelOption(value: JsonObject): ModelOption | null {
  const id = optionalString(value.id);
  const model = optionalString(value.model);
  if (!id || !model) return null;
  const efforts = array(value.supportedReasoningEfforts).flatMap((candidate) => {
    const option = object(candidate);
    const reasoningEffort = optionalString(option.reasoningEffort);
    return reasoningEffort ? [{ reasoningEffort, description: String(option.description ?? "") }] : [];
  });
  const serviceTiers = array(value.serviceTiers).flatMap((candidate) => {
    const option = object(candidate);
    const tierId = optionalString(option.id);
    return tierId ? [{
      id: tierId,
      name: optionalString(option.name) ?? tierId,
      description: String(option.description ?? ""),
    }] : [];
  });
  for (const tierId of array(value.additionalSpeedTiers).flatMap((candidate) => typeof candidate === "string" ? [candidate] : [])) {
    if (!serviceTiers.some((tier) => tier.id === tierId)) serviceTiers.push({ id: tierId, name: tierId, description: "" });
  }
  return {
    id,
    model,
    displayName: optionalString(value.displayName) ?? model,
    description: String(value.description ?? ""),
    providerId: null,
    providerDisplayName: null,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: optionalString(value.defaultReasoningEffort) ?? efforts[0]?.reasoningEffort ?? "medium",
    serviceTiers,
    defaultServiceTier: normalizedOptionalString(value.defaultServiceTier),
    isDefault: value.isDefault === true,
  };
}

function syncSessionFromThread(session: SessionRecord, response: JsonObject): boolean {
  const thread = object(response.thread);
  let changed = false;
  const title = optionalString(thread.name);
  if (title && title !== session.title) {
    session.title = title;
    session.titleSource = "codex";
    changed = true;
  }
  const modelSource = "model" in response ? response.model : thread.model;
  if ("model" in response || "model" in thread) {
    const model = normalizedOptionalString(modelSource);
    if (model !== session.model) {
      session.model = model;
      changed = true;
    }
  }
  const providerSource = "modelProvider" in response ? response.modelProvider : thread.modelProvider;
  if ("modelProvider" in response || "modelProvider" in thread) {
    const provider = normalizedOptionalString(providerSource);
    if (provider !== session.modelProvider) {
      session.modelProvider = provider;
      changed = true;
    }
  }
  const effortSource = "reasoningEffort" in response ? response.reasoningEffort : thread.reasoningEffort;
  if ("reasoningEffort" in response || "reasoningEffort" in thread) {
    const effort = normalizedOptionalString(effortSource);
    if (effort !== session.reasoningEffort) {
      session.reasoningEffort = effort;
      changed = true;
    }
  }
  const serviceTierSource = "serviceTier" in response ? response.serviceTier : thread.serviceTier;
  if ("serviceTier" in response || "serviceTier" in thread) {
    const serviceTier = normalizedOptionalString(serviceTierSource);
    if (serviceTier !== session.serviceTier) {
      session.serviceTier = serviceTier;
      changed = true;
    }
  }
  return changed;
}

function syncSessionFromSettings(session: SessionRecord, settings: JsonObject): boolean {
  let changed = false;
  if ("model" in settings) {
    const model = normalizedOptionalString(settings.model);
    if (model !== session.model) {
      session.model = model;
      changed = true;
    }
  }
  if ("modelProvider" in settings) {
    const provider = normalizedOptionalString(settings.modelProvider);
    if (provider !== session.modelProvider) {
      session.modelProvider = provider;
      changed = true;
    }
  }
  if ("effort" in settings) {
    const effort = normalizedOptionalString(settings.effort);
    if (effort !== session.reasoningEffort) {
      session.reasoningEffort = effort;
      changed = true;
    }
  }
  if ("serviceTier" in settings) {
    const serviceTier = normalizedOptionalString(settings.serviceTier);
    if (serviceTier !== session.serviceTier) {
      session.serviceTier = serviceTier;
      changed = true;
    }
  }
  return changed;
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

/** A carried turn id is fresh only when it is the active turn. The server names
 * a turn in `turn/started` or the `turn/start` result, and both promote it to
 * `activeTurnId` the moment they arrive, so while `activeTurnId` is still null
 * no id is expected yet and none is ever assumed fresh. While the session's
 * `turn/start` is in flight an id carried then may name the very turn its
 * result is about to confirm, so callers hold such an envelope back until the
 * continuation settles the turn (`deferWhileStarting`); at any other time it
 * can only be a replay from an earlier turn and is refused. */
function isFreshTurn(runtime: SessionRuntime, params: JsonObject): boolean {
  const turnId = optionalString(params.turnId);
  if (turnId === undefined) return true;
  return runtime.activeTurnId === turnId;
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}
