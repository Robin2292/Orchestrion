import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { AgentRepository } from "../agents/repository";
import type { AgentRecord, CreateAgentInput, CreateProjectInput, CreateSessionInput, SessionRecord } from "../shared/contracts";
import type { LocalFolderIdentity } from "../shared/execution-attempt-contracts";
import { BindSessionAgentSchema, type BindSessionAgentInput } from "../shared/session-tree-contracts";
import { StorageError, type SqliteFoundation, type SqliteUnit } from "../storage/sqlite/foundation";
import { SessionTreeRepository } from "../storage/sqlite/session-tree";
import type { GovernedSessionInput } from "./governed-tools";
import { hostOwnedWork, type AssertRequestActive } from "./request-guard";
import type { MetadataStore, StoredMetadata } from "./store";
import { nodeWorkspaceFileSystem, snapshotProjectRoot, type WorkspaceFileSystem } from "./workspace-files";

/** One persistent owner per lane: legacy JSON remains native; governed project,
 * immutable version selection and session state commit only in SQLite. There is
 * no adoption/backfill or second write whose failure could promote a native session. */
export class SessionTreeService implements MetadataStore {
  constructor(private readonly native: MetadataStore, private readonly foundation: () => SqliteFoundation,
    private readonly fs: WorkspaceFileSystem = nodeWorkspaceFileSystem) {}
  private transaction<T>(work: (repo: SessionTreeRepository, tx: SqliteUnit) => T): T {
    const store = this.foundation();
    return store.transaction(tx => work(new SessionTreeRepository(tx, store.workspace), tx));
  }
  async read(): Promise<StoredMetadata> {
    const native = await this.native.read();
    const governed = this.transaction(repo => {
      const project = repo.project();
      return { projects: project ? [project.record] : [], agents: repo.agents(), sessions: repo.sessions() };
    });
    for (const kind of ["projects", "agents", "sessions"] as const)
      if (native[kind].some(row => governed[kind].some(bound => bound.id === row.id))) throw new StorageError("SESSION_IDENTITY_CONFLICT");
    return {
      projects: [...native.projects.map(row => ({ ...row, executionMode: "native" as const })), ...governed.projects],
      agents: [...native.agents.map(row => ({ ...row, executionMode: "native" as const, localAgentVersionId: undefined })), ...governed.agents],
      sessions: [...native.sessions.map(row => ({ ...row, executionMode: "native" as const, governance: null })), ...governed.sessions],
    };
  }
  async bindSessionAgent(raw: BindSessionAgentInput, assertActive: AssertRequestActive = hostOwnedWork): Promise<AgentRecord> {
    const input = BindSessionAgentSchema.parse(raw);
    if (!isAbsolute(input.path) || input.path.includes("\0")) throw new StorageError("INVALID_PAYLOAD");
    assertActive();
    const native = await this.native.read(), context = this.foundation().workspace;
    if (native.projects.some(row => row.id === context.project_id) || native.agents.some(row => row.id === input.agentId))
      throw new StorageError("SESSION_IDENTITY_CONFLICT");
    const root = await snapshotProjectRoot(input.path, this.fs);
    const identity: LocalFolderIdentity = { kind: "local_folder", canonical_path: root.canonicalPath, dev: root.dev, ino: root.ino };
    assertActive();
    return this.transaction((repo, tx) => {
      const agents = new AgentRepository(tx, context); agents.authorize(true);
      const agent = agents.get(input.agentId);
      if (!agent || agent.deletedAt || !agent.latestVersionId) throw new StorageError("AGENT_NOT_FOUND");
      const version = agents.version(agent.id, input.versionId);
      if (!version) throw new StorageError("AGENT_VERSION_NOT_FOUND");
      // This path runs the Codex Session host, not other Local execution presets.
      if (version.definition.nodeType !== "agent" && version.definition.nodeType !== "coding_agent")
        throw new StorageError("SESSION_PRESET_UNSUPPORTED");
      const instructions = version.definition.nodeType === "agent" ? version.definition.systemPrompt ?? ""
        : String(version.definition.config?.prompt ?? "");
      assertActive();
      return repo.bind(root.canonicalPath, identity, { id: agent.id, projectId: context.project_id, name: `${agent.name} · v${version.versionNumber}`,
        instructions, createdAt: new Date().toISOString(), executionMode: "governed", localAgentVersionId: version.id });
    });
  }
  async createProject(input: CreateProjectInput, active: AssertRequestActive = hostOwnedWork) {
    return { ...await this.native.createProject(input, active), executionMode: "native" as const };
  }
  async createAgent(input: CreateAgentInput, active: AssertRequestActive = hostOwnedWork) {
    if (input.projectId === this.foundation().workspace.project_id) throw new StorageError("SESSION_PUBLISHED_AGENT_REQUIRED");
    return { ...await this.native.createAgent(input, active), executionMode: "native" as const };
  }
  async createSession(input: CreateSessionInput, active: AssertRequestActive = hostOwnedWork): Promise<SessionRecord> {
    active();
    const governed = this.transaction(repo => repo.agents().find(row => row.id === input.agentId));
    if (!governed) return { ...await this.native.createSession(input, active), executionMode: "native", governance: null };
    const now = new Date().toISOString();
    const session: SessionRecord = { id: randomUUID(), agentId: governed.id, title: input.title?.trim() || "Untitled session", threadId: null,
      model: input.model?.trim() || null, modelProvider: input.modelProvider?.trim() || null, reasoningEffort: input.reasoningEffort?.trim() || null,
      titleSource: input.titleSource ?? "provisional", createdAt: now, updatedAt: now, executionMode: "governed", governance: null };
    this.transaction((repo, tx) => {
      const agents = new AgentRepository(tx, repo.context), agent = agents.get(governed.id);
      if (!agent || agent.deletedAt || !agents.version(agent.id, governed.localAgentVersionId!)) throw new StorageError("AGENT_VERSION_NOT_FOUND");
      active(); repo.insert(session);
    });
    return session;
  }
  private assertNativeTree(kind: "project" | "agent", id: string): void {
    const governed = kind === "project" ? id === this.foundation().workspace.project_id
      : this.transaction(repo => repo.agents().some(row => row.id === id));
    if (governed) throw new StorageError("SESSION_PUBLISHED_AGENT_REQUIRED");
  }
  async renameProject(id: string, name: string, active: AssertRequestActive = hostOwnedWork) {
    active(); this.assertNativeTree("project", id);
    if (!this.native.renameProject) throw new StorageError("SERVICE_UNAVAILABLE");
    return { ...await this.native.renameProject(id, name, active), executionMode: "native" as const };
  }
  async renameAgent(id: string, name: string, active: AssertRequestActive = hostOwnedWork) {
    active(); this.assertNativeTree("agent", id);
    if (!this.native.renameAgent) throw new StorageError("SERVICE_UNAVAILABLE");
    return { ...await this.native.renameAgent(id, name, active), executionMode: "native" as const };
  }
  async deleteProject(id: string, active: AssertRequestActive = hostOwnedWork): Promise<void> {
    active(); this.assertNativeTree("project", id);
    if (!this.native.deleteProject) throw new StorageError("SERVICE_UNAVAILABLE");
    await this.native.deleteProject(id, active);
  }
  async deleteAgent(id: string, active: AssertRequestActive = hostOwnedWork): Promise<void> {
    active(); this.assertNativeTree("agent", id);
    if (!this.native.deleteAgent) throw new StorageError("SERVICE_UNAVAILABLE");
    await this.native.deleteAgent(id, active);
  }
  async updateSession(session: SessionRecord, active: AssertRequestActive = hostOwnedWork): Promise<void> {
    active();
    if (this.transaction(repo => !!repo.session(session.id))) { this.transaction(repo => { active(); repo.update(session); }); return; }
    if (session.executionMode === "governed") throw new StorageError("SESSION_BINDING_INVALID");
    const { executionMode: _mode, ...native } = session; void _mode;
    await this.native.updateSession({ ...native, governance: null }, active);
  }
  async deleteSession(id: string, active: AssertRequestActive = hostOwnedWork): Promise<void> {
    active();
    if (this.transaction(repo => !!repo.session(id))) { this.transaction(repo => { active(); repo.delete(id); }); return; }
    await this.native.deleteSession(id, active);
  }
  /** The production declaration gate never consumes a JSON governance marker. */
  async resolveBinding(input: GovernedSessionInput): Promise<{ agentVersionId: string; identity: LocalFolderIdentity } | null> {
    const binding = this.transaction(repo => {
      const session = repo.session(input.sessionId), project = repo.project(), agent = repo.agents().find(row => row.id === input.agentId);
      if (!session || session.agentId !== input.agentId || !project || !agent || input.projectId !== repo.context.project_id
          || input.projectPath !== project.record.path) return null;
      return { agentVersionId: agent.localAgentVersionId!, identity: project.identity };
    });
    if (!binding) return null;
    const root = await snapshotProjectRoot(input.projectPath, this.fs);
    return root.canonicalPath === binding.identity.canonical_path && root.dev === binding.identity.dev && root.ino === binding.identity.ino ? binding : null;
  }
}
