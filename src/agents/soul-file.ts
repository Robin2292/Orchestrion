import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_SOUL_MAX_BYTES, AgentSoulDraftSchema, type AgentSoulDraft,
  type AgentSoulSnapshot } from "../shared/agent-soul-contracts";
import { StorageError } from "../storage/sqlite/foundation";
import type { LocalAgentService } from "./service";
import { normalizeAgentSoul } from "./soul-document";

/** The only Local file authority for Agent SOUL drafts. Paths are derived from
 * host userData and generated UUID identities; no renderer path is accepted. */
export class AgentSoulFileService {
  constructor(private readonly userData: string, private readonly agents: LocalAgentService) {}

  private location(agentId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId))
      throw new StorageError("INVALID_PAYLOAD");
    let parent = this.userData;
    for (const segment of ["agents", agentId]) {
      parent = join(parent, segment);
      const stat = lstatSync(parent, { throwIfNoEntry: true });
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new StorageError("SOUL_FILE_UNAVAILABLE");
    }
    return join(parent, "SOUL.md");
  }

  private file(agentId: string): { snapshot: AgentSoulSnapshot; stat: ReturnType<typeof fstatSync> } | null {
    let path: string;
    try { path = this.location(agentId); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof StorageError) throw error;
      throw new StorageError("SOUL_FILE_UNAVAILABLE");
    }
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new StorageError("SOUL_FILE_UNAVAILABLE");
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > AGENT_SOUL_MAX_BYTES + 3)
        throw new StorageError(stat.size > AGENT_SOUL_MAX_BYTES + 3 ? "SOUL_TOO_LARGE" : "SOUL_FILE_UNAVAILABLE");
      const bytes = readFileSync(fd);
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new StorageError("SOUL_INVALID_CONTENT"); }
      return { snapshot: normalizeAgentSoul(content), stat };
    } finally { closeSync(fd); }
  }

  read(agentId: string): AgentSoulDraft {
    const agent = this.agents.assertCanEdit(agentId);
    const version = agent.latestVersionId
      ? this.agents.reference({ agentId, versionId: agent.latestVersionId }) : null;
    const current = this.file(agentId);
    if (current) return AgentSoulDraftSchema.parse({ ...current.snapshot,
      source: "managed_file", publishedVersionId: agent.latestVersionId });
    // This is a preview only. Old versions keep their real legacy provenance;
    // no historical SOUL file or snapshot is synthesized in SQLite.
    const legacy = [version?.definition.systemPrompt ?? "", agent.legacyDraft?.instructions ?? ""]
      .filter(Boolean).join("\n\n");
    return AgentSoulDraftSchema.parse({ ...normalizeAgentSoul(version?.soul?.content ?? legacy),
      source: version?.soul ? "version_preview" : "legacy_preview",
      publishedVersionId: agent.latestVersionId });
  }

  private directorySync(path: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  /** CAS on both released version and external file hash. An external editor's
   * atomic replacement is detected by inode before rename. */
  save(agentId: string, content: string, expectedHash: string, publishedVersionId: string | null): AgentSoulDraft {
    this.agents.assertCanEdit(agentId);
    const current = this.read(agentId);
    if (current.hash !== expectedHash || current.publishedVersionId !== publishedVersionId)
      throw new StorageError("SOUL_CONFLICT");
    const next = normalizeAgentSoul(content);
    if (next.hash === current.hash && current.source === "managed_file") return current;
    let path: string;
    try {
      const root = join(this.userData, "agents");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const existing = lstatSync(root);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new StorageError("SOUL_FILE_UNAVAILABLE");
      const agentDir = join(root, agentId);
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      path = this.location(agentId);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("SOUL_FILE_UNAVAILABLE");
    }
    const temp = join(this.userData, "agents", agentId, `.SOUL-${randomUUID()}.tmp`);
    let tempCreated = false;
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      tempCreated = true;
      try { writeFileSync(fd, Buffer.from(next.content, "utf8")); fsyncSync(fd); }
      finally { closeSync(fd); }
      const before = this.file(agentId);
      if (before?.snapshot.hash !== (current.source === "managed_file" ? expectedHash : undefined))
        throw new StorageError("SOUL_CONFLICT");
      if (before) {
        const linked = lstatSync(path);
        if (linked.ino !== before.stat.ino || linked.dev !== before.stat.dev
          || linked.mtimeMs !== before.stat.mtimeMs || linked.size !== before.stat.size)
          throw new StorageError("SOUL_CONFLICT");
        renameSync(temp, path);
      } else {
        linkSync(temp, path); unlinkSync(temp);
      }
      tempCreated = false;
      this.directorySync(join(this.userData, "agents", agentId));
      return this.read(agentId);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StorageError("SOUL_CONFLICT");
      throw new StorageError("SOUL_FILE_UNAVAILABLE");
    } finally {
      if (tempCreated) try { unlinkSync(temp); } catch { /* best effort temp cleanup */ }
    }
  }

  publishedDraft(agentId: string): AgentSoulSnapshot {
    const file = this.file(agentId);
    if (!file) throw new StorageError("SOUL_FILE_UNAVAILABLE");
    return file.snapshot;
  }

  open(agentId: string, expectedHash: string): string {
    this.agents.assertCanEdit(agentId);
    const current = this.read(agentId);
    if (current.hash !== expectedHash) throw new StorageError("SOUL_CONFLICT");
    if (current.source !== "managed_file") this.save(agentId, current.content, current.hash, current.publishedVersionId);
    return this.location(agentId);
  }
}
