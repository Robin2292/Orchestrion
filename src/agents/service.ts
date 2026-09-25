import { createHash, randomUUID } from "node:crypto";
import { readJsonArray } from "../shared/json-array";
import { AgentVersionCloneSchema, AgentCreateSchema, AgentUpdateSchema, AgentVersionCreateSchema, AgentIdSchema, AgentReferenceSchema,
  AgentPageSchema, LocalAgentSchema, LocalAgentVersionSchema, LegacySessionSchema, AgentSoulPublishSchema,
  type LocalAgent, type AgentDefinition } from "../shared/agent-contracts";
import { LocalContextSchema, LocalCommandHeaderSchema, type LocalContext, type LocalCommandHeader } from "../shared/local-contracts";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { ToolGrantRepository } from "../grants/repository";
import type { ToolGrantSet } from "../shared/tool-grant-contracts";
import { AgentRepository, AGENT_FENCE } from "./repository";
import { LocalAssignmentRepository } from "../assignments/repository";
import { DEFAULT_AGENT_SOUL, type AgentSoulSnapshot } from "../shared/agent-soul-contracts";
import { normalizeAgentSoul } from "./soul-document";

/** Stable JSON identity for Local DTO commands only; not a Web release/authority hash. */
export function agentCommandBytes(value: unknown): string {
  function normalize(v: unknown, depth: number): unknown {
    if (depth > 64) throw new StorageError("INVALID_PAYLOAD");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) return v;
    if (Array.isArray(v)) {
      const items = readJsonArray(v);
      if (!items) throw new StorageError("INVALID_PAYLOAD");
      return items.map((item) => normalize(item, depth + 1));
    }
    if (typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype)
      return Object.fromEntries(Object.keys(v).sort().map((key) => [normalize(key, depth + 1), normalize((v as Record<string, unknown>)[key], depth + 1)]));
    throw new StorageError("INVALID_PAYLOAD");
  }
  const bytes = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new StorageError("INVALID_PAYLOAD");
  return bytes;
}
export class LocalAgentService {
  #context: LocalContext;
  constructor(private readonly store: SqliteFoundation, context: LocalContext,
    private readonly clock: () => Date = () => new Date(),
    private readonly validateAuthoredGrants?: (grants: ToolGrantSet | null) => ToolGrantSet | null) {
    this.#context = LocalContextSchema.parse(context);
    this.read((r) => r.ensureFence());
  }
  get context(): LocalContext { return structuredClone(this.#context); }
  private read<T>(work: (r: AgentRepository) => T): T {
    return this.store.transaction((tx) => { const r = new AgentRepository(tx, this.#context); r.authorize(); return work(r); });
  }
  authority() { return { context: this.context, runtime_owner: this.store.owner, expected: this.read((r) => r.pin()), run: null }; }
  private authored(definition: AgentDefinition): AgentDefinition {
    if (!this.validateAuthoredGrants || definition.toolGrants === undefined) return definition;
    return { ...definition, toolGrants: this.validateAuthoredGrants(definition.toolGrants) };
  }
  private live(r: AgentRepository, id: string): LocalAgent {
    const a = r.get(id);
    if (!a || a.deletedAt) throw new StorageError("AGENT_NOT_FOUND");
    return a;
  }
  private mutate(header: LocalCommandHeader, command: string, payload: unknown, work: (r: AgentRepository, tx: SqliteUnit) => string) {
    header = LocalCommandHeaderSchema.parse(header);
    if (header.run !== null) throw new StorageError("INVALID_PAYLOAD");
    const bytes = agentCommandBytes(payload);
    // Recheck role even on a durable replay: membership alone does not grant writes.
    this.read((r) => r.authorize(true));
    return this.store.commit({ trustedContext: this.#context, header, command, resourceKey: AGENT_FENCE,
      canonicalContent: bytes, nextHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }, (tx) => {
      const r = new AgentRepository(tx, this.#context); r.authorize(true); return work(r, tx);
    });
  }
  create(header: LocalCommandHeader, raw: unknown) {
    agentCommandBytes(raw);
    const parsed = AgentCreateSchema.parse(raw);
    const p = { ...parsed, definition: this.authored(parsed.definition) };
    return this.mutate(header, "agent.create", p, (r, tx) => {
      const now = this.clock().toISOString();
      const a = LocalAgentSchema.parse({ schemaVersion: "orchestrion.local.agent.v1", context: this.context,
        id: randomUUID(), nodeType: p.definition.nodeType, name: p.name, description: p.description, userGuide: p.userGuide,
        latestVersionId: null, legacyDraft: null, createdAt: now, updatedAt: now, deletedAt: null });
      r.insert(a); this.append(r, tx, a, p.definition, now, p.definition.nodeType === "agent"
        ? normalizeAgentSoul(p.definition.systemPrompt ?? DEFAULT_AGENT_SOUL) : undefined);
      if (a.nodeType === "agent") new LocalAssignmentRepository(tx,this.#context).insertLegacyAgent(a.id,a.name,now);
      return a.id;
    });
  }
  private append(r: AgentRepository, tx: SqliteUnit, a: LocalAgent, definition: AgentDefinition, now: string,
    soul?: AgentSoulSnapshot): string {
    if (definition.nodeType !== a.nodeType) throw new StorageError("AGENT_NODE_TYPE_IMMUTABLE");
    if (definition.nodeType === "agent") {
      soul ??= normalizeAgentSoul(definition.systemPrompt ?? "");
      definition = { ...definition, systemPrompt: soul.content };
    }
    const grants = new ToolGrantRepository(tx, this.#context).validate(definition.toolGrants);
    if (definition.toolGrants !== undefined) definition = { ...definition, toolGrants: grants };
    const previous = a.latestVersionId ? r.version(a.id, a.latestVersionId) : null;
    const v = LocalAgentVersionSchema.parse({ schemaVersion: "orchestrion.local.agent.v1", context: this.context,
      id: randomUUID(), agentId: a.id, versionNumber: (previous?.versionNumber ?? 0) + 1, definition,
      ...(soul ? { soul } : {}), createdAt: now });
    r.insertVersion(v); return v.id;
  }
  update(header: LocalCommandHeader, raw: unknown) {
    agentCommandBytes(raw); const p = AgentUpdateSchema.parse(raw);
    return this.mutate(header, "agent.update", p, (r,tx) => {
      const agent=this.live(r, p.id);
      r.update(p.id, p.name, p.description, p.userGuide, this.clock().toISOString());
      if (agent.nodeType === "agent") new LocalAssignmentRepository(tx,this.#context).syncLegacyName(p.id,p.name);
      return p.id;
    });
  }
  createVersion(header: LocalCommandHeader, raw: unknown) {
    agentCommandBytes(raw); const parsed = AgentVersionCreateSchema.parse(raw);
    const p = { ...parsed, definition: this.authored(parsed.definition) };
    return this.mutate(header, "agent.version.create", p, (r, tx) => {
      const agent = this.live(r, p.agentId), now = this.clock().toISOString();
      if (agent.nodeType === "agent" && !new LocalAssignmentRepository(tx,this.#context).identity(agent.id))
        throw new StorageError("AGENT_IDENTITY_UNAVAILABLE");
      if (p.sourceVersionId !== undefined) throw new StorageError("INVALID_PAYLOAD");
      // Binding validation and the immutable append happen in this same SQLite
      // transaction as metadata. Any T0 or CAS failure rolls back every write,
      // including the fence and idempotency receipt.
      const versionId = this.append(r, tx, agent, p.definition, now);
      if (p.metadata) {
        r.update(agent.id, p.metadata.name, p.metadata.description, p.metadata.userGuide, now);
        if (agent.nodeType === "agent")
          new LocalAssignmentRepository(tx,this.#context).syncLegacyName(agent.id,p.metadata.name);
      }
      return versionId;
    });
  }
  cloneVersion(header: LocalCommandHeader, raw: unknown) {
    agentCommandBytes(raw); const p = AgentVersionCloneSchema.parse(raw);
    const immutableSource = this.read((r) => {
      this.live(r, p.agentId);
      const source = r.version(p.agentId, p.versionId);
      if (!source) throw new StorageError("AGENT_VERSION_NOT_FOUND");
      return source;
    });
    const authoredDefinition = this.authored(structuredClone(immutableSource.definition));
    return this.mutate(header, "agent.version.clone", p, (r, tx) => {
      const agent = this.live(r, p.agentId), source = r.version(p.agentId, p.versionId);
      if (!source) throw new StorageError("AGENT_VERSION_NOT_FOUND");
      if (agent.nodeType === "agent" && !new LocalAssignmentRepository(tx,this.#context).identity(agent.id))
        throw new StorageError("AGENT_IDENTITY_UNAVAILABLE");
      return this.append(r, tx, agent, authoredDefinition, this.clock().toISOString());
    });
  }
  delete(header: LocalCommandHeader, raw: unknown) {
    const p = AgentIdSchema.parse(raw);
    return this.mutate(header, "agent.delete", p, (r,tx) => {
      const agent=this.live(r, p.id);
      if (r.referenced(p.id)) throw new StorageError("AGENT_REFERENCED");
      const now=this.clock().toISOString();
      if (agent.nodeType === "agent") new LocalAssignmentRepository(tx,this.#context).retainLegacyRemoval(p.id,now);
      r.delete(p.id, now); return p.id;
    });
  }
  get(raw: unknown) { const p = AgentIdSchema.parse(raw); return this.read((r) => this.live(r, p.id)); }
  assertCanEdit(agentId: string) {
    return this.read((r) => { r.authorize(true); const agent = this.live(r, agentId);
      if (agent.nodeType !== "agent") throw new StorageError("INVALID_PAYLOAD"); return agent; });
  }
  publishSoul(header: LocalCommandHeader, raw: unknown,
    loadDraft: () => AgentSoulSnapshot) {
    const p = AgentSoulPublishSchema.parse(raw);
    return this.mutate(header, "agent.soul.publish", p, (r, tx) => {
      const agent = this.live(r, p.agentId);
      if (agent.nodeType !== "agent" || !agent.latestVersionId)
        throw new StorageError("AGENT_VERSION_NOT_FOUND");
      if (agent.latestVersionId !== p.publishedVersionId) throw new StorageError("SOUL_CONFLICT");
      if (!new LocalAssignmentRepository(tx, this.#context).identity(agent.id))
        throw new StorageError("AGENT_IDENTITY_UNAVAILABLE");
      const latest = r.version(agent.id, agent.latestVersionId);
      if (!latest) throw new StorageError("AGENT_VERSION_NOT_FOUND");
      const soul = loadDraft();
      if (soul.hash !== p.expectedHash || !soul.content.trim())
        throw new StorageError(soul.content.trim() ? "SOUL_CONFLICT" : "SOUL_INVALID_CONTENT");
      return this.append(r, tx, agent, latest.definition, this.clock().toISOString(), soul);
    });
  }
  list(raw: unknown) { const p = AgentPageSchema.parse(raw); return this.read((r) => r.list(p.limit, p.offset)); }
  versions(raw: unknown) {
    const p = AgentIdSchema.merge(AgentPageSchema).parse(raw);
    return this.read((r) => { this.live(r, p.id); return r.versions(p.id, p.limit, p.offset); });
  }
  reference(raw: unknown) {
    const p = AgentReferenceSchema.parse(raw);
    return this.read((r) => {
      this.live(r, p.agentId); const v = r.version(p.agentId, p.versionId);
      if (!v) throw new StorageError("AGENT_VERSION_NOT_FOUND");
      return v; // A0 persisted definition only. No execution or Tool/Workflow authority.
    });
  }
  legacySessions() { return this.read((r) => r.legacySessions().map((v) => LegacySessionSchema.parse(v))); }
}
