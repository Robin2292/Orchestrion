import { mkdir, readFile, rename, stat, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRecord, CreateAgentInput, CreateProjectInput, CreateSessionInput, ProjectRecord, SessionRecord } from "../shared/contracts";
import { SessionGovernanceSchema } from "../shared/governed-tool-contracts";

import { hostOwnedWork, type AssertRequestActive } from "./request-guard";

export interface StoredMetadata {
  projects: ProjectRecord[];
  agents: AgentRecord[];
  sessions: SessionRecord[];
}

const EMPTY: StoredMetadata = { projects: [], agents: [], sessions: [] };

export interface MetadataStore {
  bindSessionAgent?(input: import("../shared/session-tree-contracts").BindSessionAgentInput, assertActive?: AssertRequestActive): Promise<AgentRecord>;
  read(): Promise<StoredMetadata>;
  createProject(input: CreateProjectInput, assertActive?: AssertRequestActive): Promise<ProjectRecord>;
  createAgent(input: CreateAgentInput, assertActive?: AssertRequestActive): Promise<AgentRecord>;
  createSession(input: CreateSessionInput, assertActive?: AssertRequestActive): Promise<SessionRecord>;
  // Native tree metadata only. Governed bindings have a different lifecycle.
  renameProject?(id: string, name: string, assertActive?: AssertRequestActive): Promise<ProjectRecord>;
  renameAgent?(id: string, name: string, assertActive?: AssertRequestActive): Promise<AgentRecord>;
  deleteProject?(id: string, assertActive?: AssertRequestActive): Promise<void>;
  deleteAgent?(id: string, assertActive?: AssertRequestActive): Promise<void>;
  updateSession(session: SessionRecord, assertActive?: AssertRequestActive): Promise<void>;
  deleteSession(sessionId: string, assertActive?: AssertRequestActive): Promise<void>;
}

export class JsonMetadataStore implements MetadataStore {
  private state: StoredMetadata | null = null;
  private writes = Promise.resolve();
  private loading: Promise<void> | null = null;

  constructor(private readonly filePath: string) {}

  static inUserData(userData: string): JsonMetadataStore {
    return new JsonMetadataStore(join(userData, "orchestrion-desktop.json"));
  }

  async read(): Promise<StoredMetadata> {
    if (!this.state) {
      this.loading ??= this.load();
      await this.loading;
    }
    return structuredClone(this.state!);
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoredMetadata>;
      this.state = {
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        agents: Array.isArray(parsed.agents) ? parsed.agents : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map(normalizeSession) : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = structuredClone(EMPTY);
    }
  }

  async createProject(input: CreateProjectInput, assertActive: AssertRequestActive = hostOwnedWork): Promise<ProjectRecord> {
    const value = structuredClone(input);
    return this.mutate(assertActive, async (state) => {
      const path = value.path.trim();
      const info = await stat(path);
      if (!info.isDirectory()) throw new Error("Project path must be a directory");
      if (state.projects.some((project) => project.path === path)) throw new Error("That project directory is already registered");
      const record = { id: randomUUID(), name: required(value.name, "Project name"), path, createdAt: new Date().toISOString() };
      assertActive();
      state.projects.push(record);
      return record;
    });
  }

  async createAgent(input: CreateAgentInput, assertActive: AssertRequestActive = hostOwnedWork): Promise<AgentRecord> {
    const value = structuredClone(input);
    return this.mutate(assertActive, (state) => {
      if (!state.projects.some((project) => project.id === value.projectId)) throw new Error("Project not found");
      const record = {
        id: randomUUID(), projectId: value.projectId, name: required(value.name, "Agent name"),
        instructions: value.instructions.trim(), createdAt: new Date().toISOString(),
      };
      assertActive();
      state.agents.push(record);
      return record;
    });
  }

  async createSession(input: CreateSessionInput, assertActive: AssertRequestActive = hostOwnedWork): Promise<SessionRecord> {
    const value = structuredClone(input);
    return this.mutate(assertActive, (state) => {
      if (!state.agents.some((agent) => agent.id === value.agentId)) throw new Error("Agent not found");
      const now = new Date().toISOString();
      const record: SessionRecord = {
        id: randomUUID(), agentId: value.agentId, title: optional(value.title) ?? "Untitled session",
        threadId: null, model: optional(value.model), modelProvider: optional(value.modelProvider),
        reasoningEffort: optional(value.reasoningEffort), serviceTier: optional(value.serviceTier), titleSource: value.titleSource ?? "provisional",
        createdAt: now, updatedAt: now,
      };
      assertActive();
      state.sessions.push(record);
      return record;
    });
  }

  async renameProject(id: string, name: string, active: AssertRequestActive = hostOwnedWork): Promise<ProjectRecord> {
    return this.mutate(active, (state) => {
      const record = state.projects.find(row => row.id === id);
      if (!record) throw new Error("Project not found");
      record.name = required(name, "Project name");
      return record;
    });
  }

  async renameAgent(id: string, name: string, active: AssertRequestActive = hostOwnedWork): Promise<AgentRecord> {
    return this.mutate(active, (state) => {
      const record = state.agents.find(row => row.id === id);
      if (!record) throw new Error("Agent not found");
      record.name = required(name, "Agent name");
      return record;
    });
  }

  async deleteProject(id: string, active: AssertRequestActive = hostOwnedWork): Promise<void> {
    return this.mutate(active, (state) => {
      if (!state.projects.some(row => row.id === id)) throw new Error("Project not found");
      if (state.agents.some(row => row.projectId === id)) throw new Error("Remove this project's agents individually before removing the project.");
      state.projects = state.projects.filter(row => row.id !== id);
    });
  }

  async deleteAgent(id: string, active: AssertRequestActive = hostOwnedWork): Promise<void> {
    return this.mutate(active, (state) => {
      if (!state.agents.some(row => row.id === id)) throw new Error("Agent not found");
      if (state.sessions.some(row => row.agentId === id)) throw new Error("Manage this agent's sessions individually before removing the agent.");
      state.agents = state.agents.filter(row => row.id !== id);
    });
  }

  async updateSession(session: SessionRecord, assertActive: AssertRequestActive = hostOwnedWork): Promise<void> {
    const value = structuredClone(session);
    return this.mutate(assertActive, (state) => {
      const index = state.sessions.findIndex((candidate) => candidate.id === value.id);
      if (index < 0) throw new Error("Session not found");
      assertActive();
      state.sessions[index] = value;
    });
  }

  async deleteSession(sessionId: string, assertActive: AssertRequestActive = hostOwnedWork): Promise<void> {
    return this.mutate(assertActive, (state) => {
      const index = state.sessions.findIndex((candidate) => candidate.id === sessionId);
      if (index < 0) return;
      assertActive();
      state.sessions.splice(index, 1);
    });
  }

  /** Queue the mutation itself, not a snapshot of already-published shared state.
   * Only a successful atomic replacement publishes the isolated draft in memory.
   * Rejected/cancelled writes cannot poison the queue or leak into a later write. */
  private mutate<T>(assertActive: AssertRequestActive, change: (draft: StoredMetadata) => T | Promise<T>): Promise<T> {
    assertActive();
    const operation = this.writes.then(async () => {
      assertActive();
      await this.read();
      assertActive();
      const draft = structuredClone(this.state!);
      const value = await change(draft);
      assertActive();
      await this.persist(draft, assertActive);
      // The rename has committed. Publishing its outcome is host-owned even if
      // revocation arrives after the syscall; do not pretend to undo that commit.
      this.state = draft;
      return structuredClone(value);
    });
    this.writes = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persist(draft: StoredMetadata, assertActive: AssertRequestActive): Promise<void> {
    assertActive();
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let replaced = false;
    try {
      assertActive();
      await writeFile(temporary, JSON.stringify(draft, null, 2), { encoding: "utf8", mode: 0o600 });
      assertActive(); // final live check immediately before the atomic replacement
      await rename(temporary, this.filePath);
      replaced = true;
    } finally {
      if (!replaced) await unlink(temporary).catch(() => undefined);
    }
  }

}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optional(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeSession(value: SessionRecord): SessionRecord {
  const governance = SessionGovernanceSchema.safeParse(value.governance);
  return {
    ...value,
    model: optional(value.model),
    modelProvider: optional(value.modelProvider),
    reasoningEffort: optional(value.reasoningEffort),
    serviceTier: optional(value.serviceTier),
    titleSource: value.titleSource ?? (value.title === "Untitled session" ? "provisional" : "codex"),
    // A malformed marker is dropped: no governance, never a partially trusted one.
    governance: governance.success ? governance.data : null,
  };
}
