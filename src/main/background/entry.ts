import { RealtimeService } from "../../realtime/service";
import { REALTIME_BOOTSTRAP, REALTIME_NOTICE } from "../../shared/realtime-contracts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { packagedPtyFactory } from "./native-pty";
import { DesktopRuntime, GovernedSessionReadinessError } from "../runtime";
import { JsonMetadataStore } from "../store";
import { SessionTreeService } from "../session-tree";
import { WorkspaceTerminalService } from "../workspace-terminal";
import { launchCodex } from "../codex-process";
import { ChildProcessTransport } from "../json-rpc";
import { BackgroundService, type HostDocument } from "./service";
import { localFailure } from "../../shared/local-contracts";
import { IPC } from "../../shared/contracts";
import { SqliteFoundation, StorageError } from "../../storage/sqlite/foundation";
import { HostCredentialService } from "../credentials/service";
import { packagedKeychain } from "../credentials/keychain";
import { credentialEndpoint } from "../credentials/endpoint";
import type { CodexOAuthDiagnostic, CodexOAuthDiagnosticMessage } from "../credentials/codex-oauth-diagnostics";
import { CodexAccountUiService } from "../credentials/codex-account-ui";
import { CodexAccountConnection } from "../credentials/codex-account-connection";
import { HostCodexOAuthCeremony, type HostOAuthBinding } from "../credentials/codex-oauth-ceremony";
import { CODEX_AUTHORIZE_URL, CODEX_CLIENT_ID, CODEX_REDIRECT_URI,
  CodexOAuthProvider } from "../credentials/codex-oauth-provider";
import { CodexAccountRepository } from "../../storage/sqlite/codex-account";
import { FoundationOwner } from "./foundation-owner";
import { startBackgroundJobs } from "./jobs";
import { LocalAgentService } from "../../agents/service";
import { LocalAgentUiEndpoint } from "../../agents/ui-endpoint";
import { AgentSoulUiEndpoint } from "../../agents/soul-ui-endpoint";
import { LocalProjectAssignmentService } from "../../assignments/service";
import { LocalBudgetCeilingService } from "../../budgets/service";
import { LocalAssignmentUiEndpoint } from "../../assignments/ui-endpoint";
import { LocalAgentCatalogService } from "../../assignments/catalog-service";
import { DirectSessionService } from "../../direct-sessions/service";
import { LocalDirectSessionUiEndpoint } from "../../direct-sessions/ui-endpoint";
import { DirectCodexTurnService, codexTextBinding } from "../../direct-sessions/codex-turn";
import { CodexResponsesText, CodexTextError } from "../../providers/codex-responses-text";
import { reportCodexTextDiagnostic } from "../../providers/codex-text-diagnostics";
import { localDirectAuthoringSnapshot, validateLocalAuthoredGrantSet } from "../../grants/authoring";
import { ToolRegistry } from "../../tools/registry";
import { LocalPolicyService, type PolicyHostResolver } from "../../policies/service";
import { LocalPolicyUiEndpoint } from "../../policies/ui-endpoint";
import { GovernedFileReadHost, governedPolicyResolver } from "../governed-tools";
import { HostProcessExecutor, ProcessTreeSupervisor } from "../host-process-executor";

const port = process.parentPort;
if (!port) throw new Error("Background host requires its application parent");
const userData = process.argv[2];
if (!userData) throw new Error("Background host requires application state directory");
const send = (message: unknown) => port.postMessage(message);
const reportCodexOAuthDiagnostic = (diagnostic: CodexOAuthDiagnostic): void => {
  const message: CodexOAuthDiagnosticMessage = { type: "codex-oauth-diagnostic", diagnostic };
  send(message);
};
const track = (pid: number | undefined, active: boolean) => { if (pid) send({ type: "child", pid, active }); };
const metadataStore = new SessionTreeService(JsonMetadataStore.inUserData(userData), () => foundation.get());
const toolRegistry = new ToolRegistry();
const processExecutor = new HostProcessExecutor({ supervisor: new ProcessTreeSupervisor({ track }) });
let localPolicyService: LocalPolicyService | undefined;
// EP1-B/EP1-C governed built-ins are declared per Session through
// thread/start.dynamicTools and executed on item/tool/call. Every dependency is
// borrowed lazily from the same foundation owner; nothing opens a second store
// or process authority path.
const governedHost = new GovernedFileReadHost({
  sessionBinding: (input) => metadataStore.resolveBinding(input),
  store: () => foundation.get(),
  metadata: metadataStore,
  registry: toolRegistry,
  policy: () => resolvePolicies(),
  process: processExecutor,
});
const runtime = new DesktopRuntime(metadataStore, (assertActive) => launchCodex({
  assertActive,
  spawnTransport: (executable) => {
    const child = spawn(executable, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], detached: true, env: process.env });
    track(child.pid, true);
    child.once("exit", () => track(child.pid, false));
    child.stderr.on("data", () => {}); // never forward raw native logs
    return new ChildProcessTransport(child);
  },
}), governedHost);
const nativePty = packagedPtyFactory(join(__dirname, "native/node-pty"));
const terminals = new WorkspaceTerminalService((id) => runtime.projectPathForSession(id), {
  async spawn(options, assertActive) {
    const pty = await nativePty.spawn(options, assertActive);
    track(pty.pid, true);
    pty.onExit(() => track(pty.pid, false));
    return pty;
  },
});
// All host consumers borrow this exact accessor; only shutdown closes the owner.
const foundation = new FoundationOwner(() => SqliteFoundation.open(join(userData, "local-foundation")));
const jobs = startBackgroundJobs(foundation);
let realtime: RealtimeService | undefined;
const keychain = packagedKeychain(join(__dirname, "native/keychain.node"));
let localAgentService: LocalAgentService | undefined;
let localAssignmentService: LocalProjectAssignmentService | undefined;
let directSessionService: DirectSessionService | undefined;
const directTextBindings=new Map<string,{sessionId:string;agentVersionId:string;documentId:string;
  binding:import("../../direct-sessions/service").DirectExecutionBinding}>();
const directTextControllers=new Map<string,Set<AbortController>>();
let codexAccountUi: CodexAccountUiService | undefined;
const codexDocuments = new Map<string, HostDocument>();
const CODEX_SUBSCRIPTION_CONNECTOR_ID = "4a988a73-3242-4c6e-8a88-e7a1e039d174";
let oauthOwnerDocument: HostDocument | null = null;
const codexProvider = new CodexOAuthProvider();
const selectedCodexAccount = (): string | null => {
  const store = foundation.get(), c = store.workspace;
  const pins = store.transaction(tx => new CodexAccountRepository(tx,
    { org_id: c.org_id, principal: c.principal }, c.project_id, CODEX_SUBSCRIPTION_CONNECTOR_ID).activePins());
  const accounts = new Set(pins.map(pin => pin.accountId));
  return accounts.size === 1 ? [...accounts][0] : null;
};
const codexBinding = (document: HostDocument | null): HostOAuthBinding | null => {
  if (!document?.isActive()) return null;
  try {
    const store = foundation.get(), c = store.workspace;
    const member = store.transaction(tx => tx.get(`SELECT 1 FROM memberships m JOIN projects p
      ON p.org_id=m.org_id AND p.id=? WHERE m.org_id=? AND m.principal_type=? AND m.principal_id=?`,
    c.project_id, c.org_id, c.principal.type, c.principal.id));
    if (c.principal.type !== "user" || !member) return null;
    return { orgId: c.org_id, principalId: c.principal.id, projectId: c.project_id,
      connectorId: CODEX_SUBSCRIPTION_CONNECTOR_ID, windowId: document.id,
      sessionId: document.id, accountId: selectedCodexAccount() };
  } catch { return null; }
};
const codexConnection = (document: HostDocument) => {
  const store = foundation.get(), c = store.workspace;
  const credentials = new HostCredentialService(store, keychain,
    { org_id: c.org_id, principal: c.principal }, {
      isActive: () => !!codexBinding(document),
      allow: (_operation, connector) => connector === CODEX_SUBSCRIPTION_CONNECTOR_ID,
    });
  return new CodexAccountConnection(store, credentials, CODEX_SUBSCRIPTION_CONNECTOR_ID,
    () => codexBinding(document), selectedCodexAccount, Date.now, reportCodexOAuthDiagnostic);
};
const resolveCodexAccountUi = () => {
  if (codexAccountUi) return codexAccountUi;
  if (process.platform !== "darwin") return codexAccountUi = new CodexAccountUiService(
    foundation.get(), CODEX_SUBSCRIPTION_CONNECTOR_ID);
  const ceremony = new HostCodexOAuthCeremony({ enabled: true, clientId: CODEX_CLIENT_ID,
    authorizeUrl: CODEX_AUTHORIZE_URL, redirectUri: CODEX_REDIRECT_URI,
    scope: "openid profile email offline_access", timeoutMs: 120_000 }, {
    readBinding: () => codexBinding(oauthOwnerDocument),
    openSystemBrowser: url => {
      if (!oauthOwnerDocument?.isActive() || !oauthOwnerDocument.openOAuth) throw new Error("CODEX_OAUTH_UNAVAILABLE");
      return oauthOwnerDocument.openOAuth(url);
    },
    exchangeCode: input => codexProvider.exchangeCode(input),
    verifyAccount: tokens => codexProvider.verifyAccount(tokens),
    completeConnection: handoff => !!oauthOwnerDocument &&
      !!codexAccountUi?.completeFromCallback(oauthOwnerDocument, handoff),
    reportFailure: reportCodexOAuthDiagnostic,
  });
  codexAccountUi = new CodexAccountUiService(foundation.get(), CODEX_SUBSCRIPTION_CONNECTOR_ID, {
    ceremony,
    prepareStart: document => { oauthOwnerDocument = document; },
    connection: document => codexConnection(document),
    readBinding: documentId => codexBinding(codexDocuments.get(documentId) ?? null),
    readVerifiedAccount: selectedCodexAccount,
    reportFailure: reportCodexOAuthDiagnostic,
    refreshDue: (document, pin) => codexConnection(document).needsRefresh(pin),
    recover: document => { const connection = codexConnection(document);
      connection.repairOperations(); connection.repairPending(); },
    refresh: async (document, pin) => {
      await codexConnection(document).refresh(pin, { enabled: true, timeoutMs: 20_000,
        refresh: async (refreshToken, signal) => {
          const tokens = await codexProvider.refresh(refreshToken, signal);
          try { return { tokens, verifiedAccountId: await codexProvider.verifyAccount(tokens) }; }
          catch { tokens.accessToken = ""; tokens.refreshToken = undefined; tokens.idToken = undefined;
            throw new Error("CODEX_OAUTH_UNAVAILABLE"); }
        } });
    },
  });
  return codexAccountUi;
};
// Organization floor plus agent-version leaf, both proved from storage (EP1-B).
const policyResolver: PolicyHostResolver = governedPolicyResolver(toolRegistry);
const resolveAgents = () => {
  const store = foundation.get();
  localAgentService ??= new LocalAgentService(store,store.workspace,undefined,(grants) =>
    validateLocalAuthoredGrantSet(localDirectAuthoringSnapshot(store,toolRegistry,resolvePolicies()),grants));
  return localAgentService;
};
const resolvePolicies = () => {
  const store = foundation.get();
  localPolicyService ??= new LocalPolicyService(store,store.workspace,policyResolver,toolRegistry);
  return localPolicyService;
};
const resolveAssignments = () => {
  const store=foundation.get();
  localAssignmentService ??= new LocalProjectAssignmentService(store,store.workspace,undefined,undefined,
    (tx,context,assignmentId) => LocalBudgetCeilingService.resolveForAssignment(
      tx,context,assignmentId,context.project_id));
  return localAssignmentService;
};
const resolveDirectSessions = () => {
  const store=foundation.get();
  directSessionService ??= new DirectSessionService(store,store.workspace,(context,session,binding)=>{
    const live=directTextBindings.get(binding.workspaceBindingId);
    return !!live&&context.org_id===store.workspace.org_id&&context.project_id===store.workspace.project_id
      &&session.id===live.sessionId&&session.agent_version_id===live.agentVersionId
      &&JSON.stringify(binding)===JSON.stringify(live.binding)
      &&!!codexDocuments.get(live.documentId)?.isActive();
  });
  return directSessionService;
};
const localAssignmentUi = new LocalAssignmentUiEndpoint(resolveAssignments,() => {
  const store=foundation.get();
  return new LocalAgentCatalogService(store,store.workspace);
});
const localDirectSessionUi = new LocalDirectSessionUiEndpoint(resolveDirectSessions,document=>{
  codexDocuments.set(document.id,document);
  const store=foundation.get(),direct=resolveDirectSessions(),controller=new AbortController();
  const active=directTextControllers.get(document.id)??new Set<AbortController>();
  active.add(controller);directTextControllers.set(document.id,active);
  const credential=()=>{
    const binding=codexBinding(document),account=selectedCodexAccount();
    if(!binding||!account||binding.accountId!==account)throw new CodexTextError("PROVIDER_AUTH_EXPIRED");
    const c=store.workspace,pins=store.transaction(tx=>new CodexAccountRepository(tx,
      {org_id:c.org_id,principal:c.principal},c.project_id,CODEX_SUBSCRIPTION_CONNECTOR_ID)
      .activePins().filter(pin=>pin.accountId===account));
    if(pins.length!==1)throw new CodexTextError("PROVIDER_AUTH_EXPIRED");
    const pin={credential_ref:pins[0].ref,connector_id:CODEX_SUBSCRIPTION_CONNECTOR_ID,
      revision:pins[0].revision};
    const checked=codexConnection(document).inspect(pin);
    if(!checked.ok||checked.value.state!=="ready")throw new CodexTextError("PROVIDER_AUTH_EXPIRED");
    return {pin,account};
  };
  let pinned:ReturnType<typeof credential>|null=null;
  const samePin=(a:ReturnType<typeof credential>,b:ReturnType<typeof credential>)=>
    a.account===b.account&&a.pin.credential_ref===b.pin.credential_ref
      &&a.pin.revision===b.pin.revision;
  const provider={
    bindingHash:()=>{try {
      pinned??=credential();
      return createHash("sha256").update(JSON.stringify(["codex-direct-auth-v1",
        store.workspace.org_id,store.workspace.project_id,store.workspace.principal,
        pinned.account,pinned.pin.credential_ref,pinned.pin.revision])).digest("hex");
    } catch{return null;}},
    complete:async(messages:readonly {role:"system"|"user"|"assistant";content:string}[],signal:AbortSignal)=>{
      const selected=pinned,currentBefore=credential();let token="";
      if(!selected||!samePin(selected,currentBefore))throw new CodexTextError("PROVIDER_AUTH_EXPIRED");
      const consumed=codexConnection(document).consume(selected.pin,bytes=>{
        const parsed:unknown=JSON.parse(bytes.toString("utf8"));
        if(!parsed||typeof parsed!=="object"||!("accessToken" in parsed)
          ||typeof parsed.accessToken!=="string")throw new Error("CREDENTIAL_UNAVAILABLE");
        token=parsed.accessToken;
      });
      if(!consumed.ok||!token)throw new CodexTextError("PROVIDER_AUTH_EXPIRED");
      try {
        let result;
        try {
          result=await new CodexResponsesText().complete({token,accountId:selected.account,
            model:"gpt-6-luna",messages},AbortSignal.any([signal,controller.signal,
              AbortSignal.timeout(30_000)]));
        } catch(error) {
          // The ledger retains UNKNOWN after dispatch. Send only allowlisted
          // metadata; never the request, response, account or token.
          if(error instanceof CodexTextError)
            reportCodexTextDiagnostic(send,{kind:"failure",code:error.code,stage:error.stage??null});
          else reportCodexTextDiagnostic(send,{kind:"failure",code:"PROVIDER_UNAVAILABLE",stage:null});
          throw error;
        }
        // This marks parsed provider transport only. Credential revalidation
        // and ProviderCall settlement still decide the Direct outcome.
        reportCodexTextDiagnostic(send,{kind:"transport_completed"});
        const current=credential();
        if(!samePin(selected,current)||controller.signal.aborted)
          throw new CodexTextError("PROVIDER_AUTH_EXPIRED");
        return result;
      } finally {token="";}
    },
  };
  const service=new DirectCodexTurnService(store,direct,resolveAgents(),keychain,provider,
    (sessionId,agentVersionId,idempotencyKey)=>{
      if(!document.isActive()||!provider.bindingHash())throw new StorageError("DIRECT_PROVIDER_UNAVAILABLE");
      const binding=codexTextBinding(sessionId,agentVersionId,idempotencyKey);
      if(directTextBindings.has(binding.workspaceBindingId))
        throw new StorageError("DIRECT_ATTEMPT_STATE_CONFLICT");
      directTextBindings.set(binding.workspaceBindingId,{sessionId,agentVersionId,documentId:document.id,binding});
      return {binding,release:()=>directTextBindings.delete(binding.workspaceBindingId)};
    });
  return {service,signal:controller.signal,release:()=>{
    controller.abort();active.delete(controller);if(!active.size)directTextControllers.delete(document.id);
  }};
});
const localAgentUi = new LocalAgentUiEndpoint(resolveAgents,(service) => {
  if (service.context.org_id !== foundation.get().workspace.org_id
    || service.context.project_id !== foundation.get().workspace.project_id
    || service.context.principal.type !== foundation.get().workspace.principal.type
    || service.context.principal.id !== foundation.get().workspace.principal.id)
    throw new StorageError("CONTEXT_MISMATCH");
  return localDirectAuthoringSnapshot(foundation.get(),toolRegistry,resolvePolicies());
});
const localAgentSoulUi = new AgentSoulUiEndpoint(resolveAgents,userData);
const localPolicyUi = new LocalPolicyUiEndpoint(resolvePolicies);
const service = new BackgroundService(runtime, terminals, async (wire, document) => {
  try {
    const store = foundation.get();
    return await credentialEndpoint(store, doc => new HostCredentialService(store, keychain,
      { org_id: store.workspace.org_id, principal: store.workspace.principal }, {
        isActive: () => doc.isActive(), allow: operation => operation === "inspect",
      }))(wire, document);
  } catch { return localFailure("SERVICE_UNAVAILABLE"); }
}, {
  async invoke(channel, wire, document) {
    try {
      realtime ??= new RealtimeService(jobs.service(), (documentId, generation) => send({ type: "event", channel: REALTIME_NOTICE,
        documentId, value: { version: "synthetic.notice.v1", generation } }));
      return channel === REALTIME_BOOTSTRAP ? realtime.authority(document) ?? localFailure("NOT_AUTHENTICATED") : realtime.handle(wire, document);
    } catch { return localFailure("SERVICE_UNAVAILABLE"); }
  },
  revoke(id) { realtime?.revoke(id); }, stop() { realtime?.stop(); },
}, async (wire, document) => localAgentUi.invoke(wire, () => document.isActive()),
async (wire, document) => localPolicyUi.invoke(wire, () => document.isActive()),
async (wire, document) => localAssignmentUi.invoke(wire, () => document.isActive()),
async (wire, document) => localDirectSessionUi.invoke(wire, () => document.isActive(),document),
{ invoke: (wire, document) => { codexDocuments.set(document.id, document);
    return resolveCodexAccountUi().invoke(wire, document); },
  revoke: documentId => { codexAccountUi?.revoke(documentId); codexDocuments.delete(documentId); },
  shutdown: () => { codexAccountUi?.shutdown(); codexDocuments.clear(); } },
async (wire, document) => localAgentSoulUi.invoke(wire,() => document.isActive(),
  (path) => document.openSystem(path)));
const documents = new Map<string, { active: boolean; pending: number }>();
let pendingCount = 0;
const activeRequests = new Set<Promise<unknown>>();
const opened = new Map<string, (ok: boolean) => void>();
let closing = false;
let shutdownPromise: Promise<void> | null = null;
const beginShutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  for (const resolve of opened.values()) resolve(false);
  shutdownPromise = (async () => {
    realtime?.stop(); jobs.stop();
    // runtime.shutdown aborts every admitted tool and waits for process groups;
    // requests then persist their terminal event before the sole DB owner closes.
    await service.shutdown();
    await Promise.allSettled([...activeRequests]);
    foundation.close();
  })();
  return shutdownPromise;
};
// Native compatibility events retain their existing identity. They are not
// governed EventBus/Run facts; domain adapters use the F2 event port separately.
runtime.on("desktopEvent", (value) => send({ type: "event", channel: IPC.event, value }));
port.on("message", ({ data: message }) => {
  if (!message || typeof message !== "object" || closing) return;
  if (message.type === "shutdown") {
    const forced = setTimeout(() => process.exit(1), 2000); forced.unref();
    void beginShutdown().then(() => { clearTimeout(forced); process.exit(0); }, () => process.exit(1)); return;
  }
  if (message.type === "revoke" && typeof message.documentId === "string") {
    for(const controller of directTextControllers.get(message.documentId)??[])controller.abort();
    const state = documents.get(message.documentId);
    if (state) { state.active = false; if (!state.pending) documents.delete(message.documentId); }
    service.revoke(message.documentId); return;
  }
  if (message.type === "opened") { opened.get(message.id)?.(message.ok === true); return; }
  if (message.type !== "invoke" || typeof message.id !== "string" || typeof message.documentId !== "string") return;
  const { id, documentId } = message;
  if (pendingCount >= 128 || (!documents.has(documentId) && documents.size >= 128)) {
    send({ type: "result", id, value: localFailure("SERVICE_UNAVAILABLE") }); return;
  }
  const state = documents.get(documentId) ?? { active: true, pending: 0 };
  documents.set(documentId, state); state.pending++; pendingCount++;
  const active = () => !closing && state.active && documents.get(documentId) === state;
  const request = service.invoke(message.channel, message.input, {
    id: documentId, isActive: active,
    publish: (value) => { if (active()) send({ type: "event", channel: IPC.terminalEvent, documentId, value }); },
    openSystem: (path) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { opened.delete(id); reject(new Error("System adapter unavailable")); }, 5000);
      opened.set(id, (ok) => { clearTimeout(timer); opened.delete(id); if (ok && active()) resolve(); else reject(new Error("System adapter unavailable")); });
      send({ type: "open-system", id, path });
    }),
    openOAuth: (url) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { opened.delete(id); reject(new Error("OAuth browser unavailable")); }, 5000);
      opened.set(id, (ok) => { clearTimeout(timer); opened.delete(id); if (ok && active()) resolve(); else reject(new Error("OAuth browser unavailable")); });
      send({ type: "open-oauth-url", id, url });
    }),
  }).then((value) => send({ type: "result", id, value }), (error: unknown) => send({ type: "result", id,
    value: localFailure(error instanceof GovernedSessionReadinessError ? error.code : "OUTCOME_UNKNOWN") })).finally(() => {
    activeRequests.delete(request); pendingCount--; state.pending--;
    if (!state.active && !state.pending) documents.delete(documentId);
  });
  activeRequests.add(request);
});
process.on("SIGTERM", () => {
  const forced = setTimeout(() => process.exit(1), 2000); forced.unref();
  void beginShutdown().then(() => { clearTimeout(forced); process.exit(0); }, () => process.exit(1));
});
send({ type: "ready" });
