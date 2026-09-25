import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAgentService } from "../agents/service";
import { LocalAgentUiEndpoint } from "../agents/ui-endpoint";
import { LocalPolicyService } from "../policies/service";
import { ToolRegistry } from "../tools/registry";
import { fileReadImplementation } from "../tools/builtins/file-read";
import { gitImplementation } from "../tools/builtins/git-readonly";
import { ToolGrantRepository, grantDigest } from "../grants/repository";
import { SqliteFoundation, SqliteUnit } from "../storage/sqlite/foundation";
import { SessionTreeRepository } from "../storage/sqlite/session-tree";
import { LOCAL_CONTRACT_VERSION, type LocalCommandHeader } from "../shared/local-contracts";
import { LOCAL_AGENT_UI_CHANNEL, loadLocalAgentUiReply } from "../shared/agent-ui-contracts";
import { IPC, type AgentRecord, type SessionRecord } from "../shared/contracts";
import { BindSessionAgentReplySchema } from "../shared/session-tree-contracts";
import { GOVERNED_FILE_READ_MAX_BYTES, GOVERNED_FILE_READ_TOOL, GOVERNED_GIT_TOOLS, GOVERNED_TOOLS } from "../shared/governed-tool-contracts";
import type { PolicyTarget } from "../shared/policy/p1-contracts";
import { BackgroundService } from "./background/service";
import { GovernedFileReadHost, defaultGovernedPolicy, governedPolicyResolver } from "./governed-tools";
import { GOVERNED_GIT_MAX_OUTPUT_BYTES, GOVERNED_GIT_TIMEOUT_MS, HostProcessExecutor } from "./host-process-executor";
import { toolAnchor, toolDigest, toolJson } from "../tools/registry";
import { JsonRpcConnection } from "./json-rpc";
import { DesktopRuntime } from "./runtime";
import { SessionTreeService } from "./session-tree";
import { JsonMetadataStore } from "./store";
import { FakeTransport } from "./test-transport";
import { WorkspaceTerminalService } from "./workspace-terminal";

const roots: string[] = [], stores: SqliteFoundation[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "orclocal-81-")); roots.push(p); return p; };
const open = (path: string) => { const store = SqliteFoundation.open(path); stores.push(store); return store; };
afterEach(() => { vi.restoreAllMocks(); stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const fixture = JSON.parse(readFileSync(new URL("../fixtures/f1-agent-v1.json", import.meta.url), "utf8")).agentDetail.latestVersion;
const { id: _id, agentId: _agent, versionNumber: _number, createdAt: _time, skills: _skills, toolGrants: _grants, ...definition } = fixture;
void _id; void _agent; void _number; void _time;
void _skills; void _grants;
const header = (service: LocalAgentService | LocalPolicyService): LocalCommandHeader => ({
  schema_version: LOCAL_CONTRACT_VERSION, request_id: randomUUID(), idempotency_key: randomUUID(), ...service.authority(),
});
const document = { id: "test-document", isActive: () => true, publish: () => {}, openSystem: async () => {} };
async function setup() {
  const directory = root(), profile = join(directory, "db"), workspace = join(directory, "workspace"), jsonPath = join(directory, "legacy.json");
  mkdirSync(workspace); writeFileSync(join(workspace, "README.md"), "local fixture\n");
  let store = open(profile);
  const metadata = new SessionTreeService(new JsonMetadataStore(jsonPath), () => store);
  const registry = new ToolRegistry(), policy = new LocalPolicyService(store, store.workspace, governedPolicyResolver(registry), registry);
  const agents = new LocalAgentService(store, store.workspace), sourceId = "reviewed-direct-tools";
  registry.register(fileReadImplementation(store.workspace, sourceId, vi.fn()));
  for (const tool of GOVERNED_GIT_TOOLS) registry.register(gitImplementation(store.workspace, sourceId, tool, vi.fn()));
  const host = new GovernedFileReadHost({ store: () => store, metadata, registry, policy: () => policy, process: new HostProcessExecutor(),
    sessionBinding: input => metadata.resolveBinding(input) });
  const transport = new FakeTransport(), runtime = new DesktopRuntime(metadata, async () => ({ connection: new JsonRpcConnection(transport), version: "test" }), host);
  const agentUi = new LocalAgentUiEndpoint(() => agents);
  const service = new BackgroundService(runtime, new WorkspaceTerminalService(id => runtime.projectPathForSession(id)), undefined, undefined,
    async (input, doc) => agentUi.invoke(input, doc.isActive));
  const created = loadLocalAgentUiReply(await service.invoke(LOCAL_AGENT_UI_CHANNEL, { operation: "create", expected: agents.authority().expected,
    requestId: randomUUID(), idempotencyKey: randomUUID(), payload: { name: "Reader", description: null, userGuide: null,
      definition: { ...definition, toolGrants: null } } }, document));
  if (!created.ok || !created.value.detail) throw new Error("fixture setup failed");
  const agentId = created.value.detail.agent.id;
  const identity = { kind: "local_folder" as const, canonical_path: realpathSync(workspace),
    dev: Number(statSync(workspace).dev), ino: Number(statSync(workspace).ino) };
  store.transaction((tx) => tx.run("INSERT INTO local_session_tree_projects VALUES (?,?,?,?,?,?,?)",
    store.workspace.org_id, store.workspace.project_id, store.workspace.principal.type, store.workspace.principal.id,
    identity.canonical_path, JSON.stringify(identity), new Date().toISOString()));
  const activePolicies = new Map<string,string>();
  for (const tool of GOVERNED_TOOLS) {
    const id = policy.createDraft(header(policy), { target: { layer: "organization" }, toolName: tool,
      definition: defaultGovernedPolicy(tool) }).resultRef;
    const pin = () => { const release = policy.get({ id }); return { id, releaseHash: release.releaseHash, stateRevision: release.stateRevision }; };
    policy.transition(header(policy), { ...pin(), action: "review" });
    policy.transition(header(policy), { ...pin(), action: "publish" });
    policy.select(header(policy), { ...pin(), action: "activate", expectedSequence: 0 });
    activePolicies.set(tool, id);
  }
  const directGrants = { schema_version: "tool_grants@1" as const, grants: registry.list(store.workspace).map((tool) => {
    const anchor = toolAnchor(tool), policyRelease = policy.get({ id: activePolicies.get(tool.name)! });
    store.transaction((tx) => new ToolGrantRepository(tx, store.workspace).registerContract({ context: store.workspace,
      tool: { source: tool.sourceId, key: tool.name }, anchor, schema_hash: toolDigest(tool.parameters), contract_json: toolJson(tool) }));
    const isFile = tool.name === GOVERNED_FILE_READ_TOOL;
    return { tool: { source: tool.sourceId, key: tool.name }, contract: { id: anchor.tool_contract_version_id, hash: anchor.tool_contract_hash },
      connection: null, execution_target: { kind: "local_workspace" as const, id: store.workspace.project_id,
        placement: "local_trusted" as const, workspace_hash: grantDigest(identity) },
      resource_scope: { kind: "workspace_path" as const, resource: "/workspace/**" },
      constraints: { effects: ["read" as const], argument_schema_hash: toolDigest(tool.parameters),
        max_output_bytes: isFile ? GOVERNED_FILE_READ_MAX_BYTES : GOVERNED_GIT_MAX_OUTPUT_BYTES,
        max_runtime_seconds: isFile ? 30 : Math.ceil(GOVERNED_GIT_TIMEOUT_MS / 1000) },
      policy: { id: policyRelease.id, hash: policyRelease.releaseHash }, approval: null };
  }) };
  const versionId = agents.createVersion(header(agents), { agentId,
    definition: { ...definition, toolGrants: directGrants } }).resultRef;
  for (const tool of registry.list(store.workspace))
    registry.unregister(store.workspace, tool.connectorId, tool.connectionId, tool.name);
  const bindInput = { path: workspace, agentId, versionId };
  const bind = async (overrides = {}) => {
    const reply = BindSessionAgentReplySchema.parse(await service.invoke(IPC.bindSessionAgent, { ...bindInput, ...overrides }, document));
    if (!reply.ok) throw new Error(reply.error.code);
    return reply.value;
  };
  const session = async () => { await bind(); return await service.invoke(IPC.createSession, { agentId }, document) as SessionRecord; };
  const input = (s: SessionRecord) => ({ sessionId: s.id, agentId, projectId: store.workspace.project_id, projectPath: runtime.snapshot().projects.find(p => p.id === store.workspace.project_id)!.path });
  return { directory, profile, workspace, jsonPath, metadata, registry, policy, agents, host, service, runtime, transport, agentId, versionId, directGrants,
    bindInput, bind, session, input, get store() { return store; }, restart() { store.close(); store = open(profile); return new SessionTreeService(new JsonMetadataStore(jsonPath), () => store); } };
}
function activate(policy: LocalPolicyService, target: PolicyTarget, tool: string) {
  const release = policy.list().find(r => r.lifecycle === "draft" && JSON.stringify(r.target) === JSON.stringify(target) && r.toolName === tool)!;
  const pin = () => { const r = policy.get({ id: release.id }); return { id: r.id, releaseHash: r.releaseHash, stateRevision: r.stateRevision }; };
  policy.transition(header(policy), { ...pin(), action: "review" }); policy.transition(header(policy), { ...pin(), action: "publish" });
  policy.select(header(policy), { ...pin(), action: "activate", expectedSequence: 0 });
}
async function ready(f: Awaited<ReturnType<typeof setup>>, session: SessionRecord) {
  expect(await f.host.declare(f.input(session))).toBeNull();
  for (const tool of GOVERNED_TOOLS) activate(f.policy, { layer: "agent", agentId: f.agentId, versionId: f.versionId }, tool);
}
async function start(f: Awaited<ReturnType<typeof setup>>, session: SessionRecord) {
  const sending = f.service.invoke(IPC.sendMessage, { sessionId: session.id, text: "Read README" }, document);
  await vi.waitFor(() => expect(f.transport.sent.some(row => row.method === "thread/start")).toBe(true));
  const request = f.transport.request("thread/start");
  f.transport.respondTo("thread/start", { thread: { id: "thread-81" } });
  await vi.waitFor(() => expect(f.transport.sent.some(row => row.method === "turn/start")).toBe(true));
  f.transport.respondTo("turn/start", { turn: { id: "turn-81" } }); await sending;
  return request;
}

describe("ORCLOCAL-81 supported Session-tree identity path", () => {
  it("cuts a legacy draft over at its first real thread with one writer and no fabricated release",async()=>{
    const f=await setup(),session=await f.session();
    expect(f.store.transaction(tx=>tx.get("SELECT count(*) AS n FROM agent_sessions WHERE id=?",session.id)!.n)).toBe(0);
    await ready(f,session);await start(f,session);
    expect(f.store.transaction(tx=>tx.get("SELECT count(*) AS n FROM local_session_tree_sessions WHERE id=?",session.id)!.n)).toBe(0);
    expect(f.store.transaction(tx=>tx.get(`SELECT provenance,original_thread_id,agent_version_id,
      assignment_version_id FROM agent_sessions WHERE id=?`,session.id)))
      .toEqual({provenance:"legacy_unversioned",original_thread_id:"thread-81",
        agent_version_id:null,assignment_version_id:null});
    expect((await f.metadata.read()).sessions.find(row=>row.id===session.id)?.threadId).toBe("thread-81");
    await f.service.shutdown();
    const reopened=f.restart();
    expect((await reopened.read()).sessions.find(row=>row.id===session.id)?.threadId).toBe("thread-81");
  });
  it("rejects native sidebar mutation commands for governed bindings without changing their versions or sessions", async () => {
    const f = await setup();
    await f.bind();
    const session = await f.session();
    const before = await f.metadata.read();
    for (const [channel, input] of [
      [IPC.renameProject, { projectId: f.store.workspace.project_id, name: "Forged" }],
      [IPC.deleteProject, { projectId: f.store.workspace.project_id }],
      [IPC.renameAgent, { agentId: f.agentId, name: "Forged" }],
      [IPC.deleteAgent, { agentId: f.agentId }],
    ] as const) await expect(f.service.invoke(channel, input, document)).rejects.toThrow(/Manage this/);
    // The store also rejects direct callers; renderer/runtime checks are not authority.
    await expect(f.metadata.renameProject(f.store.workspace.project_id, "Forged")).rejects.toThrow("SESSION_PUBLISHED_AGENT_REQUIRED");
    await expect(f.metadata.deleteProject(f.store.workspace.project_id)).rejects.toThrow("SESSION_PUBLISHED_AGENT_REQUIRED");
    await expect(f.metadata.renameAgent(f.agentId, "Forged")).rejects.toThrow("SESSION_PUBLISHED_AGENT_REQUIRED");
    await expect(f.metadata.deleteAgent(f.agentId)).rejects.toThrow("SESSION_PUBLISHED_AGENT_REQUIRED");
    expect(await f.metadata.read()).toEqual(before);
    expect((await f.metadata.resolveBinding(f.input(session)))?.agentVersionId).toBe(f.versionId);
    expect(await new JsonMetadataStore(f.jsonPath).read()).toEqual({ projects: [], agents: [], sessions: [] });
    await f.runtime.shutdown();
  });

  it("creates via Agent UI endpoint, binds via BackgroundService, and starts all four tools through the production store/host composition", async () => {
    const f = await setup(), session = await f.session();
    expect(session.executionMode).toBe("governed"); expect(session.agentId).toBe(f.agentId);
    await ready(f, session);
    const request = await start(f, session);
    expect((request.params as { dynamicTools: { name: string }[] }).dynamicTools.map(t => t.name)).toEqual(["file_read", "git_status", "git_diff", "git_log"]);
    expect(request.params).toMatchObject({ developerInstructions: definition.systemPrompt, cwd: f.input(session).projectPath });
    const persisted = (await f.metadata.read()).sessions[0];
    expect(persisted.governance?.tools).toEqual([...GOVERNED_TOOLS]);
    expect(f.store.transaction(tx => tx.all("SELECT project_id,agent_id,agent_version_id FROM local_execution_attempts")))
      .toEqual([{ project_id: f.store.workspace.project_id, agent_id: f.agentId, agent_version_id: f.versionId }]);
    expect(await new JsonMetadataStore(f.jsonPath).read()).toEqual({ projects: [], agents: [], sessions: [] });
    const call = { threadId: "thread-81", turnId: "turn-81", callId: "call-81", tool: "file_read", arguments: { path: "README.md" } };
    expect((await f.host.execute({ sessionId: session.id, governance: persisted.governance!, call })).success).toBe(true);
    await f.service.shutdown();
  });
  it("blocks requested governed Sessions before thread/start when policies are missing; binding creates no tools or policies", async () => {
    const f = await setup(), session = await f.session();
    expect(f.policy.list().filter((release) => release.target.layer === "agent")).toEqual([]);
    expect(f.registry.list(f.store.workspace)).toEqual([]);
    await expect(f.service.invoke(IPC.sendMessage, { sessionId: session.id, text: "read" }, document)).rejects.toThrow("Governed tools are not ready");
    expect(f.transport.sent.some(row => row.method === "thread/start")).toBe(false);
    expect(f.store.transaction(tx => tx.all("SELECT 1 FROM local_execution_attempts"))).toEqual([]);
    const agentDrafts = f.policy.list().filter((release) => release.target.layer === "agent");
    expect(agentDrafts).toHaveLength(GOVERNED_TOOLS.length);
    expect(agentDrafts.every((release) => release.lifecycle === "draft")).toBe(true);
    expect(agentDrafts.map((release) => release.toolName).sort()).toEqual([...GOVERNED_TOOLS].sort());
    await f.service.shutdown();
  });
  it.each(["organization-policy", "agent-policy"] as const)("fails closed for a deactivated %s", async (state) => {
    const f = await setup(), session = await f.session(); await ready(f, session);
    for (const r of f.policy.list().filter(r => r.target.layer === (state === "organization-policy" ? "organization" : "agent")))
      f.policy.select(header(f.policy), { id: r.id, releaseHash: r.releaseHash, stateRevision: r.stateRevision, action: "deactivate", expectedSequence: f.policy.selection({ id: r.id })!.sequence });
    expect(await f.host.declare(f.input(session))).toBeNull();
    expect(f.store.transaction(tx => tx.all("SELECT 1 FROM local_execution_attempts"))).toEqual([]);
    await f.service.shutdown();
  });
  it("pins the selected published version when later versions are published and refuses implicit version rebinding", async () => {
    const f = await setup(), session = await f.session(); await ready(f, session);
    const newer = f.agents.createVersion(header(f.agents), { agentId: f.agentId,
      definition: { ...definition, toolGrants: f.directGrants, systemPrompt: "new prompt" } }).resultRef;
    await expect(f.bind({ versionId: newer })).rejects.toThrow("SESSION_VERSION_CONFLICT");
    expect(await f.host.declare(f.input(session))).not.toBeNull();
    expect(f.store.transaction(tx => tx.get("SELECT agent_version_id FROM local_execution_attempts"))?.agent_version_id).toBe(f.versionId);
    expect((await f.metadata.read()).agents[0].instructions).toBe(definition.systemPrompt);
    await f.service.shutdown();
  });
  it("replays duplicate binding after response loss/restart without changing IDs or duplicating records", async () => {
    const f = await setup(); const [a, b] = await Promise.all([f.bind(), f.bind()]); expect(b).toEqual(a);
    const session = await f.session(); await f.service.shutdown();
    const reopened = f.restart(); expect((await reopened.read()).sessions).toEqual([session]);
    expect(await reopened.bindSessionAgent(f.bindInput)).toEqual(a);
    expect((await reopened.read()).projects).toHaveLength(1); expect((await reopened.read()).agents).toHaveLength(1);
  });
  it("rolls back both folder and agent bindings on partial transaction failure, then recovers on restart", async () => {
    const f = await setup(); const run = SqliteUnit.prototype.run;
    const fault = vi.spyOn(SqliteUnit.prototype, "run").mockImplementation(function (this: SqliteUnit, sql, ...params) {
      if (sql.startsWith("INSERT INTO local_session_tree_agents")) throw new Error("injected failure");
      return run.call(this, sql, ...params);
    });
    await expect(f.bind()).rejects.toThrow("SERVICE_UNAVAILABLE"); fault.mockRestore();
    expect(f.store.transaction(tx => tx.all("SELECT 1 FROM local_session_tree_projects"))).toHaveLength(1);
    await f.service.shutdown(); const reopened = f.restart();
    await reopened.bindSessionAgent(f.bindInput); expect((await reopened.read()).agents).toHaveLength(1);
  });
  it("rejects forged renderer authority and invalid payloads before any mutation", async () => {
    const f = await setup();
    for (const input of [{ ...f.bindInput, projectId: f.store.workspace.project_id }, { ...f.bindInput, org_id: "foreign" },
      { ...f.bindInput, instructions: "forged" }, { ...f.bindInput, versionId: "" }, { ...f.bindInput, path: 4 }])
      expect(await f.service.invoke(IPC.bindSessionAgent, input, document)).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(await f.service.invoke(IPC.bindSessionAgent, f.bindInput, { ...document, isActive: () => false })).toMatchObject({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    await expect(f.bind({ path: "relative/folder" })).rejects.toThrow("INVALID_PAYLOAD");
    expect(f.store.transaction(tx => tx.all("SELECT 1 FROM local_session_tree_projects"))).toHaveLength(1);
    await f.service.shutdown();
  });
  it("rejects foreign project/agent/version and mismatched folder references", async () => {
    const f = await setup(), other = await setup();
    await expect(f.bind({ agentId: other.agentId, versionId: other.versionId })).rejects.toThrow("AGENT_NOT_FOUND");
    await expect(f.bind({ versionId: other.versionId })).rejects.toThrow("AGENT_VERSION_NOT_FOUND");
    const session = await f.session(); await ready(f, session);
    await expect(f.bind({ path: other.workspace })).rejects.toThrow("SESSION_FOLDER_CONFLICT");
    for (const change of [{ projectId: other.store.workspace.project_id }, { agentId: other.agentId }, { projectPath: other.workspace }, { sessionId: "forged-session" }])
      expect(await f.host.declare({ ...f.input(session), ...change })).toBeNull();
    await f.service.shutdown(); await other.service.shutdown();
  });
  it("refuses a real foreign project version in the same SQLite store", async () => {
    const f = await setup(), context = { ...f.store.workspace, project_id: "other-project" };
    f.store.transaction(tx => tx.run("INSERT INTO projects VALUES (?,?,?)", context.org_id, context.project_id, "Other"));
    const foreign = new LocalAgentService(f.store, context);
    const id = foreign.create(header(foreign), { name: "Foreign", description: null, userGuide: null, definition }).resultRef;
    const versionId = foreign.get({ id }).latestVersionId!;
    await expect(f.bind({ agentId: id, versionId })).rejects.toThrow("AGENT_NOT_FOUND");
    await expect(f.bind({ versionId })).rejects.toThrow("AGENT_VERSION_NOT_FOUND");
    expect(f.store.transaction(tx => tx.all("SELECT 1 FROM local_session_tree_projects"))).toHaveLength(1);
    await f.service.shutdown();
  });
  it("binds a published version with an explicit empty grant set and refuses thread startup", async () => {
    const f = await setup();
    const agentId = f.agents.create(header(f.agents), { name: "No tools", description: null, userGuide: null,
      definition: { ...definition, toolGrants: { schema_version: "tool_grants@1", grants: [] } } }).resultRef;
    await f.bind({ agentId, versionId: f.agents.get({ id: agentId }).latestVersionId! });
    const session = await f.service.invoke(IPC.createSession, { agentId }, document) as SessionRecord;
    await expect(f.service.invoke(IPC.sendMessage, { sessionId: session.id, text: "read" }, document)).rejects.toThrow("Governed tools are not ready");
    expect(f.transport.sent.some(row => row.method === "thread/start")).toBe(false);
    expect(f.store.transaction(tx => tx.all("SELECT 1 FROM local_execution_attempts"))).toEqual([]);
    await f.service.shutdown();
  });
  it("refuses document revocation during folder resolution and read-only membership", async () => {
    const f = await setup(); let checks = 0;
    await expect(f.metadata.bindSessionAgent(f.bindInput, () => { if (++checks > 1) throw new Error("NOT_AUTHENTICATED"); })).rejects.toThrow("NOT_AUTHENTICATED");
    f.store.transaction(tx => tx.run("UPDATE memberships SET role='viewer' WHERE org_id=? AND principal_id=?", f.store.workspace.org_id, f.store.workspace.principal.id));
    await expect(f.bind()).rejects.toThrow("NOT_AUTHENTICATED");
    expect(f.store.transaction(tx => tx.all("SELECT 1 FROM local_session_tree_projects"))).toHaveLength(1);
    await f.service.shutdown();
  });
  it("refuses replaced physical folders and deleted Local Agent identity", async () => {
    const f = await setup(), session = await f.session(); await ready(f, session);
    renameSync(f.workspace, `${f.workspace}-old`); mkdirSync(f.workspace);
    expect(await f.host.declare(f.input(session))).toBeNull();
    await expect(f.bind()).rejects.toThrow("SESSION_FOLDER_CONFLICT");
    rmSync(f.workspace, { recursive: true }); renameSync(`${f.workspace}-old`, f.workspace);
    expect(() => f.agents.delete(header(f.agents), { id: f.agentId })).toThrow("AGENT_REFERENCED");
    // Simulate a stale tombstone from offline recovery; normal product deletion
    // retains the referenced identity, and runtime still does not trust staleness.
    f.store.transaction(tx => tx.run("UPDATE local_agents SET deleted_at=? WHERE org_id=? AND project_id=? AND id=?", new Date().toISOString(),
      f.store.workspace.org_id, f.store.workspace.project_id, f.agentId));
    expect(await f.host.declare(f.input(session))).toBeNull();
    await expect(f.session()).rejects.toThrow("AGENT_NOT_FOUND");
    await f.service.shutdown();
  });
  it("native JSON Sessions cannot inherit governance from a marker or from a ready published Local Agent", async () => {
    const f = await setup(), governed = await f.session(); await ready(f, governed);
    const p = await f.service.invoke(IPC.createProject, { name: "Native", path: f.workspace }, document) as { id: string };
    const a = await f.service.invoke(IPC.createAgent, { projectId: p.id, name: "Native Reader", instructions: "Native" }, document) as AgentRecord;
    const session = await f.service.invoke(IPC.createSession, { agentId: a.id }, document) as SessionRecord;
    const request = await start(f, session); expect(request.params).not.toHaveProperty("dynamicTools");
    const native = new JsonMetadataStore(f.jsonPath), state = await native.read();
    state.sessions[0].executionMode = "governed";
    state.sessions[0].governance = { attemptId: "forged", threadId: "thread-81", tools: ["file.read"], declaredAt: new Date().toISOString() };
    writeFileSync(f.jsonPath, JSON.stringify(state));
    const reload = new SessionTreeService(new JsonMetadataStore(f.jsonPath), () => f.store);
    expect((await reload.read()).sessions.find(s => s.id === session.id)).toMatchObject({ executionMode: "native", governance: null });
    expect(await reload.resolveBinding({ sessionId: session.id, agentId: f.agentId, projectId: f.store.workspace.project_id, projectPath: f.input(governed).projectPath })).toBeNull();
    await f.service.shutdown();
  });
  it("rolls back failed thread persistence, cancels the attempt, deletes the orphan and remains retryable", async () => {
    const f = await setup(), session = await f.session(); await ready(f, session);
    const update = vi.spyOn(SessionTreeRepository.prototype, "update").mockImplementation(() => { throw new Error("persist failed"); });
    const sending = f.service.invoke(IPC.sendMessage, { sessionId: session.id, text: "read" }, document);
    const rejected = expect(sending).rejects.toThrow("SQLITE_TRANSACTION_FAILED");
    await vi.waitFor(() => expect(f.transport.sent.some(row => row.method === "thread/start")).toBe(true));
    f.transport.respondTo("thread/start", { thread: { id: "orphan" } });
    await vi.waitFor(() => expect(f.transport.sent.some(row => row.method === "thread/delete")).toBe(true));
    f.transport.respondTo("thread/delete", {}); await rejected; update.mockRestore();
    expect((await f.metadata.read()).sessions[0]).toMatchObject({ threadId: null, governance: null });
    expect(f.store.transaction(tx => tx.get("SELECT lifecycle FROM local_execution_attempts"))?.lifecycle).toBe("cancelled");
    expect(f.transport.sent.some(row => row.method === "turn/start")).toBe(false);
    await f.service.shutdown();
  });
  it("keeps earlier attempt owner stale after restart, while new bound Sessions remain creatable", async () => {
    const f = await setup(), session = await f.session(); await ready(f, session); await start(f, session);
    const saved = (await f.metadata.read()).sessions[0]; await f.service.shutdown();
    const reopened = f.restart();
    const result = await f.host.execute({ sessionId: session.id, governance: saved.governance!, call: {
      threadId: "thread-81", turnId: "turn-81", callId: "after-restart", tool: "file_read", arguments: { path: "README.md" },
    } });
    expect(result.success).toBe(false);
    expect(result.contentItems[0]).toMatchObject({ text: expect.stringContaining("EXECUTION_OWNER_STALE") });
    expect(await reopened.createSession({ agentId: f.agentId })).toMatchObject({ executionMode: "governed", threadId: null });
  });
});
