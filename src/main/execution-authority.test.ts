import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRepository } from "../agents/repository";
import { LocalAgentService } from "../agents/service";
import { LocalAgentSchema, LocalAgentVersionSchema } from "../shared/agent-contracts";
import { ExecutionAuthorityRefusalCodeSchema, type ExecutionAuthorityRefusalCode } from "../shared/execution-attempt-contracts";
import type { ExecutionPlacementBinding } from "../shared/execution-placement-contracts";
import { LOCAL_CONTRACT_VERSION, type LocalContext } from "../shared/local-contracts";
import { ExecutionAttemptRepository, executionBindingHash } from "../storage/sqlite/execution-attempts";
import { SqliteFoundation } from "../storage/sqlite/foundation";
import { ExecutionAuthorityResolver } from "./execution-authority";
import type { StoredMetadata } from "./store";
import { nodeWorkspaceFileSystem, snapshotProjectRoot, type WorkspaceFileSystem } from "./workspace-files";

const roots: string[] = [], stores: SqliteFoundation[] = [];
function root() { const p = mkdtempSync(join(tmpdir(), "orclocal-ep1a-resolver-")); roots.push(p); return p; }
function open(p = root()) { const s = SqliteFoundation.open(p); stores.push(s); return s; }
afterEach(() => { stores.splice(0).forEach((s) => { try { s.close(); } catch { /* already closed by the test */ } }); roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })); });

const fixture = JSON.parse(readFileSync(new URL("../fixtures/f1-agent-v1.json", import.meta.url), "utf8")).agentDetail.latestVersion;
const { id: _id, agentId: _agent, versionNumber: _n, createdAt: _time, ...definition } = fixture;
void _id; void _agent; void _n; void _time;
const NOW = "2026-09-15T00:00:00.000Z";
function header(s: LocalAgentService) { return { schema_version: LOCAL_CONTRACT_VERSION, request_id: randomUUID(), idempotency_key: randomUUID(), ...s.authority() }; }
function refusal(code: ExecutionAuthorityRefusalCode) { return { ok: false, code }; }

interface Fixture {
  profile: string; store: SqliteFoundation; context: LocalContext; workspacePath: string; metadata: StoredMetadata;
  service: LocalAgentService; agentId: string; versionId: string; sessionId: string; attemptId: string; resolver: ExecutionAuthorityResolver;
}
function placement(f: Fixture, overrides: Partial<ExecutionPlacementBinding> = {}): ExecutionPlacementBinding {
  return { schema_version: "orchestrion.execution-placement.v1", project_id: f.context.project_id, task_id: f.sessionId, attempt_id: f.attemptId,
    placement: "local_trusted", workspace: { kind: "local_folder", path: f.workspacePath }, selected_by: "user", fallback: "forbidden", frozen: true,
    disclosure: "current_host_user_not_os_sandboxed", reason_code: "USER_SELECTED_PLACEMENT", ...overrides };
}
async function identity(path: string) {
  const root = await snapshotProjectRoot(path);
  return { kind: "local_folder" as const, canonical_path: root.canonicalPath, dev: root.dev, ino: root.ino };
}
async function bind(f: Fixture, overrides: Record<string, unknown> = {}) {
  const input = { session_id: f.sessionId, attempt_id: f.attemptId, agent_id: f.agentId, agent_version_id: f.versionId, placement: placement(f),
    workspace_identity: await identity(f.workspacePath), owner: f.store.owner, bound_at: NOW, ...overrides };
  return f.store.transaction((tx) => new ExecutionAttemptRepository(tx, f.context).bind(input));
}
function move(f: Fixture, from: string, to: string, revision: number, attemptId = f.attemptId) {
  f.store.transaction((tx) => new ExecutionAttemptRepository(tx, f.context)
    .transition(attemptId, from as "bound", to as "active", revision, NOW));
}
function rows(store: SqliteFoundation) { return store.transaction((tx) => tx.all("SELECT * FROM local_execution_attempts ORDER BY attempt_id")); }
function resolverFor(f: Fixture, store: SqliteFoundation, fileSystem?: WorkspaceFileSystem) {
  return new ExecutionAuthorityResolver(store, { read: async () => structuredClone(f.metadata) }, fileSystem);
}
async function setup(): Promise<Fixture> {
  const profile = root(), store = open(profile), context = store.workspace, workspacePath = join(profile, "workspace");
  mkdirSync(workspacePath);
  const service = new LocalAgentService(store, context);
  const agentId = service.create(header(service), { name: "Reviewer", description: null, userGuide: null, definition }).resultRef;
  const versionId = service.get({ id: agentId }).latestVersionId!;
  const metadata: StoredMetadata = {
    projects: [{ id: context.project_id, name: "Personal", path: workspacePath, createdAt: NOW }],
    agents: [{ id: agentId, projectId: context.project_id, name: "Reviewer", instructions: "Review exactly.", createdAt: NOW }],
    sessions: [{ id: "session-1", agentId, title: "Review", threadId: "thread-1", model: null, modelProvider: null, reasoningEffort: null,
      titleSource: "provisional", createdAt: NOW, updatedAt: NOW }],
  };
  const f: Fixture = { profile, store, context, workspacePath, metadata, service, agentId, versionId, sessionId: "session-1", attemptId: randomUUID(),
    resolver: undefined as unknown as ExecutionAuthorityResolver };
  f.resolver = resolverFor(f, store);
  await bind(f);
  return f;
}
const request = (f: Fixture) => ({ sessionId: f.sessionId, attemptId: f.attemptId });

describe("EP1-A execution authority resolver", () => {
  it("resolves a fully valid local_trusted binding from first principles without writing", async () => {
    const f = await setup(), before = rows(f.store);
    const result = await f.resolver.resolve(request(f));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const a = result.authority;
    expect(a.context).toEqual({ org_id: f.context.org_id, principal: f.context.principal, project_id: f.context.project_id });
    expect(a.session).toEqual({ id: "session-1", agentId: f.agentId, threadId: "thread-1" });
    expect(a.project).toEqual({ id: f.context.project_id, path: f.workspacePath, canonicalPath: realpathSync(f.workspacePath) });
    expect(LocalAgentVersionSchema.parse(a.agentVersion)).toEqual(f.service.reference({ agentId: f.agentId, versionId: f.versionId }));
    expect(a.attempt).toEqual({ session_id: "session-1", attempt_id: f.attemptId, lifecycle: "bound", revision: 0, bound_at: NOW });
    expect(a.placement).toEqual(placement(f));
    expect(a.workspace).toEqual(await identity(f.workspacePath));
    expect(a.owner).toEqual(f.store.owner);
    expect(executionBindingHash(a.placement, a.workspace)).toBe(String(before[0].binding_hash));
    expect(await f.resolver.resolve(request(f))).toEqual(result);
    move(f, "bound", "active", 0);
    expect(await f.resolver.resolve(request(f))).toMatchObject({ ok: true, authority: { attempt: { lifecycle: "active", revision: 1 } } });
    expect(rows(f.store).map((r) => ({ ...r, lifecycle: "bound", revision: 0 }))).toEqual(before);
  });
  it.each([undefined, null, {}, { sessionId: "session-1" }, { sessionId: "", attemptId: "x" }, { sessionId: "session-1", attemptId: "x", extra: true }])(
    "refuses an invalid request %j", async (raw) => {
      const f = await setup();
      expect(await f.resolver.resolve(raw)).toEqual(refusal("EXECUTION_REQUEST_INVALID"));
    });
  it("refuses a missing JSON session, agent or project and a project unknown to the store", async () => {
    const f = await setup();
    expect(await f.resolver.resolve({ ...request(f), sessionId: "session-2" })).toEqual(refusal("EXECUTION_SESSION_NOT_FOUND"));
    f.metadata.sessions[0].agentId = "ghost-agent";
    expect(await f.resolver.resolve(request(f))).toEqual(refusal("EXECUTION_AGENT_NOT_FOUND"));
    f.metadata.sessions[0].agentId = f.agentId; f.metadata.agents[0].projectId = "ghost-project";
    expect(await f.resolver.resolve(request(f))).toEqual(refusal("EXECUTION_PROJECT_NOT_FOUND"));
    f.metadata.projects.push({ id: "ghost-project", name: "Unregistered", path: f.workspacePath, createdAt: NOW });
    expect(await f.resolver.resolve(request(f))).toEqual(refusal("EXECUTION_PROJECT_NOT_FOUND"));
  });
  it("refuses an unknown attempt and an attempt bound to a different session", async () => {
    const f = await setup();
    expect(await f.resolver.resolve({ ...request(f), attemptId: randomUUID() })).toEqual(refusal("EXECUTION_ATTEMPT_NOT_FOUND"));
    f.metadata.sessions.push({ ...f.metadata.sessions[0], id: "session-2" });
    expect(await f.resolver.resolve({ ...request(f), sessionId: "session-2" })).toEqual(refusal("EXECUTION_ATTEMPT_NOT_FOUND"));
  });
  it("refuses a cross-project reference even when the other project is registered", async () => {
    const f = await setup();
    f.store.transaction((tx) => tx.run("INSERT INTO projects VALUES (?,?,?)", f.context.org_id, "other-project", "Other"));
    f.metadata.projects[0].id = "other-project"; f.metadata.agents[0].projectId = "other-project";
    expect(await f.resolver.resolve(request(f))).toEqual(refusal("EXECUTION_PROJECT_MISMATCH"));
  });
  it("refuses a session re-pointed to another Agent", async () => {
    const f = await setup();
    const other = f.service.create(header(f.service), { name: "Other", description: null, userGuide: null, definition }).resultRef;
    f.metadata.agents.push({ id: other, projectId: f.context.project_id, name: "Other", instructions: "", createdAt: NOW });
    f.metadata.sessions[0].agentId = other;
    expect(await f.resolver.resolve(request(f))).toEqual(refusal("EXECUTION_AGENT_MISMATCH"));
  });
  it("refuses a LegacyDraft Agent at bind time and a retired Agent at resolve time", async () => {
    const f = await setup();
    const draft = LocalAgentSchema.parse({ schemaVersion: "orchestrion.local.agent.v1", context: f.context, id: "legacy-reviewer", nodeType: "agent",
      name: "Legacy", description: null, userGuide: null, latestVersionId: null, legacyDraft: { instructions: "Review." }, createdAt: NOW, updatedAt: NOW, deletedAt: null });
    f.store.transaction((tx) => new AgentRepository(tx, f.context).insert(draft));
    const before = rows(f.store);
    await expect(bind({ ...f, attemptId: randomUUID() }, { agent_id: "legacy-reviewer" })).rejects.toThrow("AGENT_VERSION_NOT_FOUND");
    expect(rows(f.store)).toEqual(before);
    f.service.delete(header(f.service), { id: f.agentId });
    expect(await f.resolver.resolve(request(f))).toEqual(refusal("EXECUTION_AGENT_VERSION_MISSING"));
    expect(rows(f.store)).toEqual(before);
  });
  it("refuses an attempt bound by an earlier runtime incarnation without writing", async () => {
    const f = await setup(), before = rows(f.store), bound = f.store.owner;
    f.store.close();
    const reopened = open(f.profile);
    expect(reopened.owner).toEqual({ ...bound, instance_id: reopened.owner.instance_id, epoch: bound.epoch + 1 });
    expect(reopened.owner.instance_id).not.toBe(bound.instance_id);
    expect(await resolverFor(f, reopened).resolve(request(f))).toEqual(refusal("EXECUTION_OWNER_STALE"));
    expect(rows(reopened)).toEqual(before);
  });
  it("refuses an explicit requires_rebind lifecycle and every finished lifecycle", async () => {
    const f = await setup();
    move(f, "bound", "requires_rebind", 0);
    expect(await f.resolver.resolve(request(f))).toEqual(refusal("EXECUTION_REBIND_REQUIRED"));
    for (const path of [["active", "completed"], ["active", "failed"], ["cancelled"]]) {
      const g = { ...f, attemptId: randomUUID() }; await bind(g);
      let from = "bound", revision = 0;
      for (const to of path) { move(g, from, to, revision); from = to; revision += 1; }
      expect(await f.resolver.resolve(request(g))).toEqual(refusal("EXECUTION_ATTEMPT_FINISHED"));
    }
  });
  it.each(["local_isolated", "remote_self_hosted", "managed_cloud"] as const)("refuses a stored %s placement", async (kind) => {
    const f = await setup(), g = { ...f, attemptId: randomUUID() };
    const workspace = kind === "managed_cloud" ? { kind: "repository_ref" as const, repository: "git@example.com:o/r.git", revision: "abc123", subdirectory: null }
      : { kind: "mounted_folder" as const, source_path: f.workspacePath, mount_path: "/workspace" };
    const disclosure = kind === "local_isolated" ? "local_container_isolation" : kind === "managed_cloud" ? "managed_cloud_repository_checkout" : "remote_operator_managed";
    await bind(g, { placement: placement(g, { placement: kind, workspace, disclosure }), workspace_identity: null });
    expect(await f.resolver.resolve(request(g))).toEqual(refusal("EXECUTION_PLACEMENT_UNSUPPORTED"));
  });
  it.each(["re-pointed project path", "replaced directory", "removed directory", "symlinked root", "stale identity"])("refuses folder drift: %s", async (drift) => {
    const f = await setup(), other = join(f.profile, "elsewhere"); mkdirSync(other);
    if (drift === "re-pointed project path") f.metadata.projects[0].path = other;
    if (drift === "replaced directory") { rmSync(f.workspacePath, { recursive: true }); mkdirSync(f.workspacePath); }
    if (drift === "removed directory") rmSync(f.workspacePath, { recursive: true });
    if (drift === "symlinked root") { rmSync(f.workspacePath, { recursive: true }); symlinkSync(other, f.workspacePath, "dir"); }
    if (drift === "stale identity") {
      const g = { ...f, attemptId: randomUUID() }, live = await identity(f.workspacePath);
      await bind(g, { workspace_identity: { ...live, ino: live.ino + 1 } });
      expect(await f.resolver.resolve(request(g))).toEqual(refusal("EXECUTION_WORKSPACE_DRIFT"));
      return;
    }
    expect(await f.resolver.resolve(request(f))).toEqual(refusal("EXECUTION_WORKSPACE_DRIFT"));
  });
  it("refuses a stored binding whose hash no longer matches its content", async () => {
    const f = await setup(), tampered = randomUUID(), bound = f.store.owner;
    f.store.close();
    const db = new DatabaseSync(join(f.profile, "foundation.sqlite")); db.exec("PRAGMA foreign_keys=ON");
    const forged = placement({ ...f, attemptId: tampered });
    db.prepare("INSERT INTO local_execution_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      f.context.org_id, f.context.project_id, f.context.principal.type, f.context.principal.id, f.sessionId, tampered, f.agentId, f.versionId,
      "local_trusted", JSON.stringify(forged), JSON.stringify(await identity(f.workspacePath)), `sha256:${"0".repeat(64)}`,
      bound.instance_id, bound.epoch, "bound", 0, NOW, NOW);
    db.close();
    const reopened = open(f.profile);
    expect(await resolverFor(f, reopened).resolve({ sessionId: f.sessionId, attemptId: tampered })).toEqual(refusal("EXECUTION_BINDING_INVALID"));
  });
  it.each(["lifecycle", "session"])("refuses when the %s changes while the folder is being verified", async (what) => {
    const f = await setup();
    let armed = true;
    const fileSystem: WorkspaceFileSystem = { ...nodeWorkspaceFileSystem, async lstat(path) {
      if (armed) { armed = false; if (what === "lifecycle") move(f, "bound", "requires_rebind", 0); else f.metadata.sessions[0].agentId = "ghost"; }
      return nodeWorkspaceFileSystem.lstat(path);
    } };
    expect(await resolverFor(f, f.store, fileSystem).resolve(request(f))).toEqual(refusal("EXECUTION_STATE_CHANGED"));
    expect(armed).toBe(false);
  });
  it("only ever answers with a closed refusal code and never falls back", async () => {
    const f = await setup();
    f.metadata.projects[0].path = join(f.profile, "missing");
    const result = await f.resolver.resolve(request(f));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected authority");
    expect(ExecutionAuthorityRefusalCodeSchema.parse(result.code)).toBe(result.code);
    expect(Object.keys(result)).toEqual(["ok", "code"]);
  });
});

describe("EP1-A execution attempt repository", () => {
  it("binds only the calling scope's project, a live version, and one identity per attempt", async () => {
    const f = await setup(), before = rows(f.store);
    await expect(bind(f)).rejects.toThrow("EXECUTION_ATTEMPT_EXISTS");
    await expect(bind({ ...f, attemptId: randomUUID() }, { placement: placement({ ...f, attemptId: "x" }) })).rejects.toThrow();
    f.store.transaction((tx) => tx.run("INSERT INTO projects VALUES (?,?,?)", f.context.org_id, "other-project", "Other"));
    const g = { ...f, attemptId: randomUUID(), context: { ...f.context, project_id: "other-project" } };
    await expect(bind(g, { placement: placement(g) })).rejects.toThrow("AGENT_VERSION_NOT_FOUND");
    await expect(bind(g, { placement: placement({ ...g, context: f.context }) })).rejects.toThrow("CONTEXT_MISMATCH");
    await expect(bind({ ...f, attemptId: randomUUID() }, { agent_version_id: randomUUID() })).rejects.toThrow("AGENT_VERSION_NOT_FOUND");
    await expect(bind({ ...f, attemptId: randomUUID() }, { workspace_identity: null })).rejects.toThrow();
    await expect(bind({ ...f, attemptId: randomUUID() }, { owner: { ...f.store.owner, engine: "web" } })).rejects.toThrow();
    expect(rows(f.store)).toEqual(before);
  });
  it("advances only along the closed lifecycle graph with a revision CAS", async () => {
    const f = await setup();
    expect(() => move(f, "bound", "completed", 0)).toThrow("EXECUTION_ATTEMPT_STATE_CONFLICT");
    expect(() => move(f, "bound", "active", 1)).toThrow("EXECUTION_ATTEMPT_STATE_CONFLICT");
    move(f, "bound", "active", 0);
    expect(() => move(f, "bound", "active", 1)).toThrow("EXECUTION_ATTEMPT_STATE_CONFLICT");
    move(f, "active", "requires_rebind", 1);
    expect(() => move(f, "requires_rebind", "active", 2)).toThrow("EXECUTION_ATTEMPT_STATE_CONFLICT");
    move(f, "requires_rebind", "cancelled", 2);
    expect(() => move(f, "cancelled", "bound", 3)).toThrow("EXECUTION_ATTEMPT_STATE_CONFLICT");
    expect(rows(f.store).map((r) => [r.lifecycle, r.revision])).toEqual([["cancelled", 3]]);
  });
});
