import { createHash, randomUUID } from "node:crypto";
import { constants, openSync, closeSync, readFileSync, fstatSync, lstatSync, writeSync, fsyncSync, fchmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LegacyMetadataSchema } from "../shared/agent-contracts";
import { LocalContextSchema, LocalIdSchema, LocalCommandHeaderSchema, type LocalContext, type LocalCommandHeader } from "../shared/local-contracts";
import { SqliteFoundation, StorageError } from "../storage/sqlite/foundation";
import { AgentImportRepository } from "./import-repository";
import { AGENT_FENCE } from "./repository";
import { agentCommandBytes } from "./service";

const fail = (code: string): never => { throw new StorageError(code); };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Host-selected paths only, never exposed as an IPC payload. Source is read-only
 * and must be quiescent. Exact bytes are backed up durably before any DB commit.
 * A failed DB transaction can leave a verified backup; repeat is safe. */
export function importLegacyAgents(store: SqliteFoundation, trusted: LocalContext, header: LocalCommandHeader,
  paths: { sourceId: string; sourcePath: string; backupPath: string }) {
  trusted = LocalContextSchema.parse(trusted);
  header = LocalCommandHeaderSchema.parse(header);
  const sourceId = LocalIdSchema.parse(paths.sourceId);
  const sourcePath = resolve(paths.sourcePath), backupPath = resolve(paths.backupPath);
  if (sourcePath === backupPath || header.run !== null) return fail("INVALID_PAYLOAD");
  const a = header.context;
  if (a.org_id !== trusted.org_id || a.project_id !== trusted.project_id || a.principal.type !== trusted.principal.type
    || a.principal.id !== trusted.principal.id) return fail("CONTEXT_MISMATCH");
  const owner = store.owner;
  if (header.runtime_owner.engine !== owner.engine || header.runtime_owner.instance_id !== owner.instance_id
    || header.runtime_owner.epoch !== owner.epoch) return fail("RUNTIME_OWNER_MISMATCH");
  store.transaction((tx) => { new AgentImportRepository(tx, trusted); });
  const fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 1024n * 1024n) return fail("LEGACY_SOURCE_INVALID");
    const bytes = readFileSync(fd);
    // Fatal UTF-8 prevents replacement characters from silently changing instructions.
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    agentCommandBytes(raw);
    const data = LegacyMetadataSchema.parse(raw), hash = digest(bytes);
    const unchanged = () => {
      const held = fstatSync(fd, { bigint: true }), linked = lstatSync(sourcePath, { bigint: true });
      if (!linked.isFile() || held.nlink !== 1n || linked.dev !== stat.dev || linked.ino !== stat.ino
        || held.size !== stat.size || held.mtimeNs !== stat.mtimeNs || held.ctimeNs !== stat.ctimeNs
        || digest(readFileSync(sourcePath)) !== hash) return fail("LEGACY_SOURCE_CHANGED");
    };
    unchanged();
    const previous = store.transaction((tx) => new AgentImportRepository(tx, trusted).receipt(sourceId));
    if (previous && previous.digest !== hash) return fail("LEGACY_SOURCE_CHANGED");
    // Exclusive creation; an existing backup must be the exact protected bytes.
    let backup: number;
    let created = false;
    try { backup = openSync(backupPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      backup = openSync(backupPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    try {
      // Different path strings can still refer to the source inode (for example
      // /tmp and /private/tmp). Check held descriptors before any backup write.
      const identity = fstatSync(backup, { bigint: true });
      if (identity.dev === stat.dev && identity.ino === stat.ino) return fail("LEGACY_BACKUP_INVALID");
      if (created) { fchmodSync(backup, 0o600); let offset = 0;
        while (offset < bytes.length) { const n = writeSync(backup, bytes, offset, bytes.length - offset); if (!n) return fail("LEGACY_BACKUP_FAILED"); offset += n; }
        fsyncSync(backup);
      }
      const validateBackup = () => {
        const held = fstatSync(backup, { bigint: true }), linked = lstatSync(backupPath, { bigint: true });
        if (!held.isFile() || !linked.isFile() || held.nlink !== 1n
          || held.dev !== identity.dev || held.ino !== identity.ino
          || held.dev !== linked.dev || held.ino !== linked.ino
          || (held.dev === stat.dev && held.ino === stat.ino)
          || (held.mode & 0o777n) !== 0o600n || digest(readFileSync(backupPath)) !== hash)
          return fail("LEGACY_BACKUP_INVALID");
      };
      validateBackup();
      const directory = openSync(dirname(backupPath), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      validateBackup(); unchanged();
      // Content receipt dedupes a repeated import even with a new request/key/revision.
      // Still authenticate current owner and revision through foundation.commit.
      const payload = { sourceId, digest: hash };
      const result = store.commit({ trustedContext: trusted, header, command: "agent.legacy.import", resourceKey: AGENT_FENCE,
        canonicalContent: agentCommandBytes(payload), nextHash: `sha256:${hash}` }, (tx) => {
        // Keep both descriptors held until commit and recheck pathname binding
        // after backup publication/fsync, including content-receipt reimports.
        validateBackup(); unchanged();
        const repo = new AgentImportRepository(tx, trusted); const existing = repo.receipt(sourceId);
        if (existing) { if (existing.digest !== hash) return fail("LEGACY_SOURCE_CHANGED"); return String(existing.id); }
        const id = randomUUID(); repo.insert(sourceId, id, hash, data, new Date().toISOString()); return id;
      });
      return { ...result, mappings: store.transaction((tx) => new AgentImportRepository(tx, trusted).mappings(result.resultRef)) };
    } finally { closeSync(backup); }
  } finally { closeSync(fd); }
}
