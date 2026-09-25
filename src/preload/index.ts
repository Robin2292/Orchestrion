import { REALTIME_BOOTSTRAP, REALTIME_CHANNEL, REALTIME_NOTICE, RealtimeBootstrapSchema, RealtimeReplySchema, NoticeSchema } from "../shared/realtime-contracts";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { BindSessionAgentSchema, BindSessionAgentReplySchema, GOVERNED_SESSION_NOT_READY_MESSAGE } from "../shared/session-tree-contracts";
import { LocalFailureSchema, type LocalErrorCode } from "../shared/local-contracts";
import { CREDENTIAL_READINESS_CHANNEL, CredentialReadinessWireSchema, CredentialReplySchema } from "../shared/credential-contracts";
import { CODEX_ACCOUNT_UI_CHANNEL, CodexAccountUiRequestSchema, CodexAccountUiReplySchema,
  type CodexAccountUiRequest } from "../shared/codex-account-ui-contracts";
import { DESKTOP_BRIDGE_VERSION, IPC, UPDATER_IPC, UpdaterStateSchema, type DesktopEvent, type DesktopWindowState, type OrchestrionDesktopApi, type TerminalEvent, type UpdaterState } from "../shared/contracts";
import { LOCAL_AGENT_UI_CHANNEL, LocalAgentUiRequestSchema, loadLocalAgentUiReply, type LocalAgentUiRequest, type LocalAgentUiValue } from "../shared/agent-ui-contracts";
import { LOCAL_AGENT_SOUL_CHANNEL, LocalAgentSoulRequestSchema, LocalAgentSoulReplySchema,
  type LocalAgentSoulRequest, type LocalAgentSoulValue } from "../shared/agent-soul-ui-contracts";
import { LOCAL_ASSIGNMENT_UI_CHANNEL, LocalAssignmentUiRequestSchema, loadLocalAssignmentUiReply,
  type LocalAssignmentUiRequest, type LocalAssignmentUiValue } from "../shared/assignment-ui-contracts";
import { LOCAL_DIRECT_SESSION_CHANNEL, LocalDirectSessionRequestSchema, loadLocalDirectSessionReply,
  type LocalDirectSessionRequest, type LocalDirectSessionValue } from "../shared/direct-session-ui-contracts";
import { LOCAL_POLICY_UI_CHANNEL, LocalPolicyUiRequestSchema, loadLocalPolicyUiReply, type LocalPolicyUiRequest, type LocalPolicyUiValue } from "../shared/policy/p2-ui-contracts";

// Preserve the established UI API while exposing only stable, redacted failures.
class DecodedLocalFailure extends Error {
  readonly retryable = false;
  constructor(readonly code: LocalErrorCode) { super(code); }
}

function publicLocalFailure(code: string): Error & { code: string; retryable: false } {
  const message = code === "GOVERNED_SESSION_NOT_READY" ? GOVERNED_SESSION_NOT_READY_MESSAGE : code;
  return Object.assign(new Error(message), { code, retryable: false as const });
}

let documentIdentity: Promise<string> | null = null;
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  // Captured once in this isolated preload document; never refreshed after a
  // navigation and never exposed as a renderer-chosen authority field.
  documentIdentity ??= ipcRenderer.invoke("orchestrion:document-identity").then((value) => {
    if (typeof value !== "string") throw new Error("NOT_AUTHENTICATED");
    return value;
  });
  const identity = await documentIdentity;
  let input = args[0];
  if ((channel === IPC.sendMessage || channel === IPC.startSession) && input && typeof input === "object" && "attachments" in input && Array.isArray(input.attachments)) {
    // The existing runtime discards previewUrl before sending to Codex. Do this
    // before IPC too, so display-only base64 is not copied across two processes.
    input = { ...input, attachments: input.attachments.map((value: unknown) => value && typeof value === "object" ? { ...value, previewUrl: null } : value) };
  }
  const result = await ipcRenderer.invoke(channel, input, identity);
  const failure = LocalFailureSchema.safeParse(result);
  if (failure.success) {
    throw new DecodedLocalFailure(failure.data.error.code);
  }
  return result;
}

async function invokeSession<T>(channel: typeof IPC.startSession | typeof IPC.sendMessage, input: unknown): Promise<T> {
  try {
    const value = await invoke<T>(channel, input);
    // A malformed failure is not a successful Session/void result. Only the
    // closed LocalFailure schema above is allowed to supply a public reason.
    if (value && typeof value === "object" && "ok" in value && value.ok === false) throw new Error("Malformed Session failure");
    return value;
  } catch (error) {
    if (error instanceof DecodedLocalFailure) throw publicLocalFailure(error.code);
    throw publicLocalFailure("SERVICE_UNAVAILABLE");
  }
}
const api: OrchestrionDesktopApi = {
  updaterBridge: {
    check: () => invokeUpdater(UPDATER_IPC.check),
    download: () => invokeUpdater(UPDATER_IPC.download),
    quitAndInstall: () => invokeUpdaterVoid(UPDATER_IPC.quitAndInstall),
    getState: () => invokeUpdater(UPDATER_IPC.getState),
    onState: listener => {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
        const parsed = UpdaterStateSchema.safeParse(raw);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(UPDATER_IPC.state, handler);
      return () => ipcRenderer.off(UPDATER_IPC.state, handler);
    },
  },
  localAssignments: { request: invokeLocalAssignment },
  localDirectSessions: { request: invokeLocalDirectSession },
  localAgents: {
    snapshot: () => invokeLocalAgent({ operation: "snapshot" }),
    detail: (agentId) => invokeLocalAgent({ operation: "detail", agentId }),
    create: (input) => invokeLocalAgent(input),
    update: (input) => invokeLocalAgent(input),
    createVersion: (input) => invokeLocalAgent(input),
    delete: (input) => invokeLocalAgent(input),
  },
  localAgentSoul: { request: invokeLocalAgentSoul },
  localPolicies: {
    snapshot: () => invokeLocalPolicy({ operation:"snapshot" }),
    draft: (input) => invokeLocalPolicy(input),
    transition: (input) => invokeLocalPolicy(input),
    select: (input) => invokeLocalPolicy(input),
    simulate: (input) => invokeLocalPolicy(input),
  },
  localRealtime: {
    bootstrap: async () => RealtimeBootstrapSchema.parse(await invoke(REALTIME_BOOTSTRAP)),
    request: async wire => {
      if (typeof wire !== "string" || wire.length > 32768) throw new Error("INVALID_PAYLOAD");
      const reply = RealtimeReplySchema.parse(await invoke(REALTIME_CHANNEL, wire));
      if (!reply.ok) throw new Error(reply.error.code);
      return reply.value;
    },
    onNotice: listener => {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
        const parsed = NoticeSchema.safeParse(raw); if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(REALTIME_NOTICE, handler);
      return () => ipcRenderer.off(REALTIME_NOTICE, handler);
    },
  },
  credentialReadiness: async wire => {
    if (!CredentialReadinessWireSchema.safeParse(wire).success) throw new Error("INVALID_PAYLOAD");
    const reply = CredentialReplySchema.safeParse(await invoke(CREDENTIAL_READINESS_CHANNEL, wire));
    if (!reply.success) throw new Error("CREDENTIAL_UNAVAILABLE");
    return reply.data.value;
  },
  codexAccount: request => invokeCodexAccount(request),
  bridgeInfo: Object.freeze({
    version: DESKTOP_BRIDGE_VERSION,
    capabilities: Object.freeze({
      sessionTree: Object.freeze({ bindSessionAgent: true }),
      localAgents: Object.freeze({ directToolGrants: true }),
      workspaceFiles: Object.freeze({ read: true, save: true, open: true }),
    }),
  }),
  bootstrap: () => invoke(IPC.bootstrap),
  chooseProjectDirectory: () => invoke(IPC.chooseProjectDirectory),
  chooseAttachments: () => invoke(IPC.chooseAttachments),
  chooseAttachmentFolder: () => invoke(IPC.chooseAttachmentFolder),
  resolveDroppedAttachments: (files) => {
    const paths = files.flatMap((file) => {
      try {
        const path = webUtils.getPathForFile(file as File);
        return path ? [path] : [];
      } catch {
        return [];
      }
    });
    return invoke(IPC.describeDroppedAttachments, paths);
  },
  loadAttachmentPreviews: (input) => invoke(IPC.loadAttachmentPreviews, input),
  listWorkspaceDirectory: (input) => invoke(IPC.listWorkspaceDirectory, input),
  readWorkspaceFile: (input) => invoke(IPC.readWorkspaceFile, input),
  saveWorkspaceFile: (input) => invoke(IPC.saveWorkspaceFile, input),
  openWorkspaceFile: (input) => invoke(IPC.openWorkspaceFile, input),
  createTerminal: (input) => invoke(IPC.createTerminal, input),
  sendTerminalInput: (input) => invoke(IPC.terminalInput, input),
  acknowledgeTerminalOutput: (input) => invoke(IPC.acknowledgeTerminalOutput, input),
  resizeTerminal: (input) => invoke(IPC.resizeTerminal, input),
  closeTerminal: (input) => invoke(IPC.closeTerminal, input),
  closeSessionTerminals: (input) => invoke(IPC.closeSessionTerminals, input),
  createProject: (input) => invoke(IPC.createProject, input),
  createAgent: (input) => invoke(IPC.createAgent, input),
  bindSessionAgent: async (input) => {
    const request = BindSessionAgentSchema.safeParse(input);
    if (!request.success) throw publicLocalFailure("INVALID_PAYLOAD");
    let raw: unknown;
    try { raw = await invoke(IPC.bindSessionAgent, request.data); }
    catch (error) {
      if (error instanceof DecodedLocalFailure) throw publicLocalFailure(error.code);
      throw publicLocalFailure("SERVICE_UNAVAILABLE");
    }
    const reply = BindSessionAgentReplySchema.safeParse(raw);
    if (!reply.success) throw publicLocalFailure("SERVICE_UNAVAILABLE");
    if (!reply.data.ok) throw publicLocalFailure(reply.data.error.code);
    return reply.data.value;
  },
  createSession: (input) => invoke(IPC.createSession, input),
  startSession: (input) => invokeSession(IPC.startSession, input),
  listModels: () => invoke(IPC.listModels),
  renameProject: (input) => invoke(IPC.renameProject, input),
  renameAgent: (input) => invoke(IPC.renameAgent, input),
  deleteProject: (input) => invoke(IPC.deleteProject, input),
  deleteAgent: (input) => invoke(IPC.deleteAgent, input),
  renameSession: (input) => invoke(IPC.renameSession, input),
  deleteSession: (input) => invoke(IPC.deleteSession, input),
  updateSessionSettings: (input) => invoke(IPC.updateSessionSettings, input),
  sendMessage: (input) => invokeSession(IPC.sendMessage, input),
  stopTurn: (input) => invoke(IPC.stopTurn, input),
  respondToRequest: (input) => invoke(IPC.respondToRequest, input),
  restartCodex: () => invoke(IPC.restartCodex),
  getWindowState: () => invoke(IPC.windowState),
  onWindowState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopWindowState) => listener(state);
    ipcRenderer.on(IPC.windowState, handler);
    return () => ipcRenderer.off(IPC.windowState, handler);
  },
  onTerminalEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalEvent) => listener(payload);
    ipcRenderer.on(IPC.terminalEvent, handler);
    return () => ipcRenderer.off(IPC.terminalEvent, handler);
  },
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: DesktopEvent) => listener(payload);
    ipcRenderer.on(IPC.event, handler);
    return () => ipcRenderer.off(IPC.event, handler);
  },
};

async function invokeUpdaterWire(channel: string): Promise<unknown> {
  let raw: unknown;
  try { raw = await invoke(channel); }
  catch (error) {
    if (error instanceof DecodedLocalFailure) throw publicLocalFailure(error.code);
    throw publicLocalFailure("SERVICE_UNAVAILABLE");
  }
  return raw;
}

async function invokeUpdater(channel: string): Promise<UpdaterState> {
  const raw = await invokeUpdaterWire(channel);
  const parsed = UpdaterStateSchema.safeParse(raw);
  if (!parsed.success) throw publicLocalFailure("SERVICE_UNAVAILABLE");
  return parsed.data;
}

async function invokeUpdaterVoid(channel: string): Promise<void> {
  const raw = await invokeUpdaterWire(channel);
  if (raw !== undefined) throw publicLocalFailure("SERVICE_UNAVAILABLE");
}

async function invokeLocalAgent(request: LocalAgentUiRequest): Promise<LocalAgentUiValue> {
  const parsed = LocalAgentUiRequestSchema.safeParse(request);
  if (!parsed.success) throw publicLocalFailure("INVALID_PAYLOAD");
  let raw: unknown;
  try { raw = await invoke(LOCAL_AGENT_UI_CHANNEL, parsed.data); }
  catch (error) {
    if (error instanceof DecodedLocalFailure) throw publicLocalFailure(error.code);
    throw publicLocalFailure("SERVICE_UNAVAILABLE");
  }
  let reply;
  try { reply = loadLocalAgentUiReply(raw); }
  catch { throw publicLocalFailure("SERVICE_UNAVAILABLE"); }
  if (!reply.ok) throw publicLocalFailure(reply.error.code);
  return reply.value;
}

async function invokeLocalAgentSoul(request: LocalAgentSoulRequest): Promise<LocalAgentSoulValue> {
  const parsed = LocalAgentSoulRequestSchema.safeParse(request);
  if (!parsed.success) throw publicLocalFailure("INVALID_PAYLOAD");
  let raw: unknown;
  try { raw = await invoke(LOCAL_AGENT_SOUL_CHANNEL, parsed.data); }
  catch (error) {
    if (error instanceof DecodedLocalFailure) throw publicLocalFailure(error.code);
    throw publicLocalFailure("SERVICE_UNAVAILABLE");
  }
  const reply = LocalAgentSoulReplySchema.safeParse(raw);
  if (!reply.success) throw publicLocalFailure("SERVICE_UNAVAILABLE");
  if (!reply.data.ok) throw publicLocalFailure(reply.data.error.code);
  return reply.data.value;
}

async function invokeLocalAssignment(request: LocalAssignmentUiRequest): Promise<LocalAssignmentUiValue> {
  const parsed=LocalAssignmentUiRequestSchema.safeParse(request);
  if (!parsed.success) throw publicLocalFailure("INVALID_PAYLOAD");
  let raw:unknown;
  try { raw=await invoke(LOCAL_ASSIGNMENT_UI_CHANNEL,parsed.data); }
  catch (error) {
    if (error instanceof DecodedLocalFailure) throw publicLocalFailure(error.code);
    throw publicLocalFailure("SERVICE_UNAVAILABLE");
  }
  let reply;
  try { reply=loadLocalAssignmentUiReply(raw); }
  catch { throw publicLocalFailure("SERVICE_UNAVAILABLE"); }
  if (!reply.ok) throw publicLocalFailure(reply.error.code);
  return reply.value;
}

async function invokeLocalDirectSession(request:LocalDirectSessionRequest):Promise<LocalDirectSessionValue> {
  const parsed=LocalDirectSessionRequestSchema.safeParse(request);
  if (!parsed.success) throw publicLocalFailure("INVALID_PAYLOAD");
  let raw:unknown;
  try { raw=await invoke(LOCAL_DIRECT_SESSION_CHANNEL,parsed.data); }
  catch(error) {
    if (error instanceof DecodedLocalFailure) throw publicLocalFailure(error.code);
    throw publicLocalFailure("SERVICE_UNAVAILABLE");
  }
  let reply;
  try { reply=loadLocalDirectSessionReply(raw); }
  catch { throw publicLocalFailure("SERVICE_UNAVAILABLE"); }
  if (!reply.ok) throw publicLocalFailure(reply.error.code);
  return reply.value;
}

async function invokeLocalPolicy(request: LocalPolicyUiRequest): Promise<LocalPolicyUiValue> {
  const parsed = LocalPolicyUiRequestSchema.safeParse(request);
  if (!parsed.success) throw publicLocalFailure("INVALID_PAYLOAD");
  let raw: unknown;
  try { raw = await invoke(LOCAL_POLICY_UI_CHANNEL,parsed.data); }
  catch (error) {
    if (error instanceof DecodedLocalFailure) throw publicLocalFailure(error.code);
    throw publicLocalFailure("SERVICE_UNAVAILABLE");
  }
  let reply;
  try { reply = loadLocalPolicyUiReply(raw); }
  catch { throw publicLocalFailure("SERVICE_UNAVAILABLE"); }
  if (!reply.ok) throw publicLocalFailure(reply.error.code);
  return reply.value;
}

contextBridge.exposeInMainWorld("orchestrion", api);

async function invokeCodexAccount(request: CodexAccountUiRequest) {
  const parsed = CodexAccountUiRequestSchema.safeParse(request);
  if (!parsed.success) throw publicLocalFailure("INVALID_PAYLOAD");
  let raw: unknown;
  try { raw = await invoke(CODEX_ACCOUNT_UI_CHANNEL, parsed.data); }
  catch (error) {
    if (error instanceof DecodedLocalFailure) throw publicLocalFailure(error.code);
    throw publicLocalFailure("SERVICE_UNAVAILABLE");
  }
  const reply = CodexAccountUiReplySchema.safeParse(raw);
  if (!reply.success) throw publicLocalFailure("SERVICE_UNAVAILABLE");
  return reply.data.value;
}
