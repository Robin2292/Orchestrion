import { REALTIME_CHANNEL, REALTIME_BOOTSTRAP } from "../../shared/realtime-contracts";
import { IPC } from "../../shared/contracts";
import { BindSessionAgentReplySchema, SessionBindingErrorSchema } from "../../shared/session-tree-contracts";
import { localFailure } from "../../shared/local-contracts";
import type { DesktopRuntime } from "../runtime";
import type { WorkspaceTerminalService, TerminalOwner } from "../workspace-terminal";
import { describeAttachments } from "../attachments";
import { validateRequest } from "./requests";
import { CREDENTIAL_READINESS_CHANNEL } from "../../shared/credential-contracts";
import { CODEX_ACCOUNT_UI_CHANNEL } from "../../shared/codex-account-ui-contracts";
import { LOCAL_AGENT_UI_CHANNEL } from "../../shared/agent-ui-contracts";
import { LOCAL_AGENT_SOUL_CHANNEL } from "../../shared/agent-soul-ui-contracts";
import { LOCAL_ASSIGNMENT_UI_CHANNEL } from "../../shared/assignment-ui-contracts";
import { LOCAL_DIRECT_SESSION_CHANNEL } from "../../shared/direct-session-ui-contracts";
import { LOCAL_POLICY_UI_CHANNEL } from "../../shared/policy/p2-ui-contracts";

export interface HostDocument extends TerminalOwner {
  openSystem(path: string): Promise<void>;
}

/** Reuses the existing runtime/session lock and terminal service, without a second
 * state store, domain engine, or a renderer-selected method/property dispatcher. */
export class BackgroundService {
  private bootstrap: ReturnType<DesktopRuntime["bootstrap"]> | null = null;
  constructor(readonly runtime: DesktopRuntime, readonly terminals: WorkspaceTerminalService,
    private readonly credentials?: (input: unknown, document: HostDocument) => Promise<unknown>,
    private readonly realtime?: { invoke(channel: string, input: unknown, document: HostDocument): Promise<unknown>; revoke(id: string): void; stop(): void },
    private readonly localAgents?: (input: unknown, document: HostDocument) => Promise<unknown>,
    private readonly localPolicies?: (input: unknown, document: HostDocument) => Promise<unknown>,
    private readonly localAssignments?: (input: unknown, document: HostDocument) => Promise<unknown>,
    private readonly directSessions?: (input: unknown, document: HostDocument) => Promise<unknown>,
    private readonly codexAccount?: { invoke(input: unknown, document: HostDocument): Promise<unknown>; revoke(documentId: string): void; shutdown(): void },
    private readonly agentSoul?: (input: unknown, document: HostDocument) => Promise<unknown>) {}

  async invoke(channel: string, input: unknown, document: HostDocument): Promise<unknown> {
    if (!document.isActive()) return localFailure("NOT_AUTHENTICATED");
    if (!validateRequest(channel, input)) return localFailure("INVALID_PAYLOAD");
    if (channel === REALTIME_CHANNEL || channel === REALTIME_BOOTSTRAP)
      return this.realtime ? this.realtime.invoke(channel, input, document) : localFailure("SERVICE_UNAVAILABLE");
    if (channel === CREDENTIAL_READINESS_CHANNEL)
      return this.credentials ? this.credentials(input, document) : localFailure("SERVICE_UNAVAILABLE");
    if (channel === CODEX_ACCOUNT_UI_CHANNEL)
      return this.codexAccount ? this.codexAccount.invoke(input, document) : localFailure("SERVICE_UNAVAILABLE");
    if (channel === LOCAL_AGENT_UI_CHANNEL)
      return this.localAgents ? this.localAgents(input, document) : localFailure("SERVICE_UNAVAILABLE");
    if (channel === LOCAL_AGENT_SOUL_CHANNEL)
      return this.agentSoul ? this.agentSoul(input, document) : localFailure("SERVICE_UNAVAILABLE");
    if (channel === LOCAL_ASSIGNMENT_UI_CHANNEL)
      return this.localAssignments ? this.localAssignments(input, document) : localFailure("SERVICE_UNAVAILABLE");
    if (channel === LOCAL_DIRECT_SESSION_CHANNEL)
      return this.directSessions ? this.directSessions(input, document) : localFailure("SERVICE_UNAVAILABLE");
    if (channel === LOCAL_POLICY_UI_CHANNEL)
      return this.localPolicies ? this.localPolicies(input, document) : localFailure("SERVICE_UNAVAILABLE");
    if (channel === IPC.describeDroppedAttachments) return describeAttachments(input as string[]);
    // A renderer reload reads the live snapshot; it never reconnects/hydrates twice.
    if (channel === IPC.bootstrap) {
      this.bootstrap ??= this.runtime.bootstrap();
      await this.bootstrap;
      return this.runtime.snapshot();
    }
    this.bootstrap ??= this.runtime.bootstrap();
    await this.bootstrap;
    if (!document.isActive()) return localFailure("NOT_AUTHENTICATED");
    const runtime = this.runtime;
    const assertActive = () => { if (!document.isActive()) throw new Error("NOT_AUTHENTICATED"); };
    switch (channel) {
      case IPC.createProject: return runtime.createProject(input as Parameters<typeof runtime.createProject>[0], assertActive);
      case IPC.createAgent: return runtime.createAgent(input as Parameters<typeof runtime.createAgent>[0], assertActive);
      case IPC.bindSessionAgent: {
        try { return BindSessionAgentReplySchema.parse({ ok: true, value: await runtime.bindSessionAgent(input as Parameters<typeof runtime.bindSessionAgent>[0], assertActive) }); }
        catch (error) {
          const code = SessionBindingErrorSchema.safeParse(error instanceof Error ? error.message : null);
          return { ok: false, error: { code: code.success ? code.data : "SERVICE_UNAVAILABLE", retryable: false } };
        }
      }
      case IPC.createSession: return runtime.createSession(input as Parameters<typeof runtime.createSession>[0], assertActive);
      case IPC.startSession: return runtime.startSession(input as Parameters<typeof runtime.startSession>[0], assertActive);
      case IPC.listModels: return runtime.listModels(assertActive);
      case IPC.renameProject: return runtime.renameProject(input as Parameters<typeof runtime.renameProject>[0], assertActive);
      case IPC.renameAgent: return runtime.renameAgent(input as Parameters<typeof runtime.renameAgent>[0], assertActive);
      case IPC.deleteProject: return runtime.deleteProject(input as Parameters<typeof runtime.deleteProject>[0], assertActive);
      case IPC.deleteAgent: return runtime.deleteAgent(input as Parameters<typeof runtime.deleteAgent>[0], assertActive);
      case IPC.renameSession: return runtime.renameSession(input as Parameters<typeof runtime.renameSession>[0], assertActive);
      case IPC.updateSessionSettings: return runtime.updateSessionSettings(input as Parameters<typeof runtime.updateSessionSettings>[0], assertActive);
      case IPC.sendMessage: return runtime.sendMessage(input as Parameters<typeof runtime.sendMessage>[0], assertActive);
      case IPC.stopTurn: return runtime.stopTurn(input as Parameters<typeof runtime.stopTurn>[0], assertActive);
      case IPC.respondToRequest: return runtime.respondToRequest(input as Parameters<typeof runtime.respondToRequest>[0], assertActive);
      case IPC.restartCodex: await runtime.restartCodex(assertActive); return;
      case IPC.loadAttachmentPreviews: return runtime.loadAttachmentPreviews(input as Parameters<typeof runtime.loadAttachmentPreviews>[0]);
      case IPC.listWorkspaceDirectory: return runtime.listWorkspaceDirectory(input as Parameters<typeof runtime.listWorkspaceDirectory>[0]);
      case IPC.readWorkspaceFile: return runtime.readWorkspaceFile(input as Parameters<typeof runtime.readWorkspaceFile>[0]);
      case IPC.saveWorkspaceFile: return runtime.saveWorkspaceFile(input as Parameters<typeof runtime.saveWorkspaceFile>[0], assertActive);
      case IPC.openWorkspaceFile:
        return runtime.openWorkspaceFile(input as Parameters<typeof runtime.openWorkspaceFile>[0], assertActive, (path) => document.openSystem(path));
      case IPC.deleteSession: {
        const request = input as Parameters<typeof runtime.deleteSession>[0];
        this.terminals.closeSession(request.sessionId);
        return runtime.deleteSession(request, (id) => { assertActive(); this.terminals.closeSession(id); }, assertActive);
      }
      case IPC.createTerminal: {
        const request = input as Parameters<WorkspaceTerminalService["create"]>[1];
        return this.terminals.create(document, request, (operation) => runtime.runSessionOperation(request.sessionId, operation, assertActive));
      }
      case IPC.terminalInput: return this.terminals.input(document.id, input as Parameters<WorkspaceTerminalService["input"]>[1]);
      case IPC.acknowledgeTerminalOutput: return this.terminals.acknowledgeOutput(document.id, input as Parameters<WorkspaceTerminalService["acknowledgeOutput"]>[1]);
      case IPC.resizeTerminal: return this.terminals.resize(document.id, input as Parameters<WorkspaceTerminalService["resize"]>[1]);
      case IPC.closeTerminal: return this.terminals.close(document.id, input as Parameters<WorkspaceTerminalService["close"]>[1]);
      case IPC.closeSessionTerminals: return this.terminals.closeSessionForOwner(document.id, (input as { sessionId: string }).sessionId);
      default: return localFailure("INVALID_PAYLOAD");
    }
  }
  revoke(documentId: string): void { this.codexAccount?.revoke(documentId); this.realtime?.revoke(documentId); this.terminals.closeOwner(documentId); }
  shutdown(): Promise<void> { this.codexAccount?.shutdown(); this.realtime?.stop(); this.terminals.closeAll(); return this.runtime.shutdown(); }
}
