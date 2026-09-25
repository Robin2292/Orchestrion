import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  realpathSync, rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  LocalCommandHeaderSchema, LocalContextSchema, LocalHashSchema, LocalIdSchema,
  LocalVersionPinSchema, type LocalCommandHeader, type LocalContext, type RuntimeOwner,
} from "../../shared/local-contracts";
import type { StoredMetadata } from "../../main/store";
import { migrate } from "./migrations";

/** Input only for a future Agent migration owner. Never read or imported on open. */
export interface LegacyMetadataInput { read(): Promise<StoredMetadata> }

export class StorageError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new StorageError(code); };

interface FileIdentity { dev: bigint; ino: bigint }
const sameFile = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

function validateBackupFile(path: string, fd: number, identity: FileIdentity,
  requireContent: boolean, allowedLinks: readonly bigint[] = [1n]): void {
  const held = fstatSync(fd, { bigint: true }), linked = lstatSync(path, { bigint: true });
  if (!held.isFile() || !allowedLinks.includes(held.nlink) || !sameFile(held, identity)
      || !linked.isFile() || linked.isSymbolicLink() || linked.nlink !== held.nlink || !sameFile(linked, identity)
      || (held.mode & 0o777n) !== 0o600n || (linked.mode & 0o777n) !== 0o600n
      || (requireContent && held.size === 0n)) throw new Error("backup identity or mode changed");
}

function failStagedBackup(stagingDirectory: string, fd: number, code: string): never {
  let cleanupFailed = false;
  // Cleanup is confined to our unpredictable 0700 directory. Never chmod or
  // unlink the public destination on a failure path.
  try { fchmodSync(fd, 0o000); } catch { cleanupFailed = true; }
  try { closeSync(fd); } catch { cleanupFailed = true; }
  try { rmSync(stagingDirectory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
  return fail(cleanupFailed ? "SQLITE_BACKUP_CLEANUP_FAILED" : code);
}

function failPublishedBackup(stagingDirectory: string, fd: number, code: string): never {
  let cleanupFailed = false;
  // Publication may already reference this inode. Only close it and clean the
  // private staging tree; never chmod or unlink the public destination.
  try { closeSync(fd); } catch { cleanupFailed = true; }
  try { rmSync(stagingDirectory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
  return fail(cleanupFailed ? "SQLITE_BACKUP_CLEANUP_FAILED" : code);
}

function failRetainedPublishedBackup(fd: number, code: string): never {
  try { closeSync(fd); } catch { return fail("SQLITE_BACKUP_CLEANUP_FAILED"); }
  return fail(code);
}

function plainFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("SQLITE_PROFILE_INVALID");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Internal repository capability; invalid after the synchronous callback returns.
 * SQL belongs in repositories, with org_id in every tenant query/join. Never expose
 * this capability, SQL, profile paths or migration controls to IPC/Agent code.
 */
export class SqliteUnit {
  #active = true;
  constructor(private readonly db: DatabaseSync) {}
  finish(): void { this.#active = false; }
  private check(): void { if (!this.#active) fail("SQLITE_TRANSACTION_CLOSED"); }
  run(sql: string, ...params: SQLInputValue[]) { this.check(); return this.db.prepare(sql).run(...params); }
  get(sql: string, ...params: SQLInputValue[]) { this.check(); return this.db.prepare(sql).get(...params); }
  all(sql: string, ...params: SQLInputValue[]) { this.check(); return this.db.prepare(sql).all(...params); }
}

function synchronous<T>(work: () => T): T {
  const value = work();
  if (value && (typeof value === "object" || typeof value === "function")
      && "then" in value) {
    // Suppress rejection only; the revoked unit forbids writes after an await.
    void Promise.resolve(value).catch(() => undefined);
    fail("SQLITE_ASYNC_TRANSACTION_DENIED");
  }
  return value;
}

/** Minimal scoped repository: membership is a storage boundary, not Tool policy. */
export class ProjectRepository {
  #context: LocalContext;
  constructor(private readonly tx: SqliteUnit, context: LocalContext) {
    this.#context = LocalContextSchema.parse(context);
    const c = this.#context;
    if (!tx.get(`SELECT 1 FROM memberships m JOIN projects p ON p.org_id=m.org_id
        WHERE m.org_id=? AND m.principal_type=? AND m.principal_id=? AND p.id=?`,
    c.org_id, c.principal.type, c.principal.id, c.project_id)) fail("CONTEXT_MISMATCH");
  }
  get() {
    const c = this.#context;
    return this.tx.get("SELECT org_id,id,name FROM projects WHERE org_id=? AND id=?", c.org_id, c.project_id)!;
  }
  rename(name: string): void {
    const c = this.#context;
    this.tx.run("UPDATE projects SET name=? WHERE org_id=? AND id=?", LocalIdSchema.parse(name), c.org_id, c.project_id);
  }
}

export interface FencedCommit {
  /** Independently authenticated host/service context, never copied from IPC. */
  trustedContext: LocalContext;
  header: LocalCommandHeader;
  command: string;
  resourceKey: string;
  /** Service-owned exact canonical bytes, from the existing domain canonicalizer.
   * No replacement Python/JSON number canonicalization is performed here.
   */
  canonicalContent: string;
  nextHash: string;
}

/** Unregistered storage foundation. F3 owns host lifetime; F6 owns jobs/outbox.
 * All filesystem paths are selected by the trusted host, not renderer/model input.
 */
export class SqliteFoundation {
  #closed = false;
  #transaction = false;
  #owner!: RuntimeOwner;
  #workspace!: LocalContext;
  private constructor(private readonly db: DatabaseSync, private readonly writer: DatabaseSync) {}

  static open(profilePath: string): SqliteFoundation {
    mkdirSync(profilePath, { recursive: true, mode: 0o700 });
    const profile = realpathSync(profilePath);
    const path = join(profile, "foundation.sqlite");
    const lock = join(profile, "foundation-writer.sqlite");
    for (const name of [path, `${path}-wal`, `${path}-shm`, lock, `${lock}-journal`]) plainFile(name);
    const writer = new DatabaseSync(lock);
    try {
      // A separate SQLite lock stays held across business COMMITs. OS locks release
      // on SIGKILL; no PID file, timeout takeover, or stale-lock deletion race.
      // Fresh-file header reads can briefly hold SHARED locks in both contenders.
      // Let SQLite retain the elected writer's PENDING lock while those readers
      // drain, rather than making both hosts abandon the election. This timeout
      // is only for lifetime election; business transactions still fail fast.
      writer.exec("PRAGMA busy_timeout=250; BEGIN EXCLUSIVE");
    } catch {
      writer.close();
      return fail("SQLITE_WRITER_BUSY");
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0");
      if (db.prepare("PRAGMA foreign_keys").get()!.foreign_keys !== 1
          || db.prepare("PRAGMA recursive_triggers").get()!.recursive_triggers !== 1
          || db.prepare("PRAGMA journal_mode").get()!.journal_mode !== "wal") fail("SQLITE_CONFIGURATION_INVALID");
      migrate(db);
      const store = new SqliteFoundation(db, writer);
      store.initialize();
      return store;
    } catch (error) {
      db?.close();
      writer.close();
      if (error instanceof StorageError) throw error;
      return fail("SQLITE_OPEN_FAILED");
    }
  }

  get owner(): RuntimeOwner { this.check(); return { ...this.#owner }; }
  get workspace(): LocalContext { this.check(); return structuredClone(this.#workspace); }
  private check(): void { if (this.#closed) fail("SQLITE_CLOSED"); }

  /** Storage-internal short transactions. No await, Tool effect or event publishing.
   * Domain owners must couple their repository writes to commit() below; this
   * lower level API is for bootstrap and trusted repository/migration maintenance.
   */
  transaction<T>(work: (tx: SqliteUnit) => T): T {
    this.check();
    if (this.#transaction) return fail("SQLITE_NESTED_TRANSACTION_DENIED");
    this.#transaction = true;
    const tx = new SqliteUnit(this.db);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = synchronous(() => work(tx));
      tx.finish();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      tx.finish();
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (error instanceof StorageError) throw error;
      return fail("SQLITE_TRANSACTION_FAILED");
    } finally {
      this.#transaction = false;
    }
  }

  private initialize(): void {
    this.transaction((tx) => {
      let row = tx.get("SELECT * FROM personal_workspace WHERE singleton=1");
      if (!row) {
        const org = randomUUID(), principal = randomUUID(), project = randomUUID();
        tx.run("INSERT INTO organizations VALUES (?,?)", org, "Personal workspace");
        tx.run("INSERT INTO principals VALUES ('user',?)", principal);
        tx.run("INSERT INTO memberships VALUES (?,'user',?,'owner')", org, principal);
        tx.run("INSERT INTO projects VALUES (?,?,?)", org, project, "Personal project");
        tx.run("INSERT INTO personal_workspace VALUES (1,?,'user',?,?)", org, principal, project);
        row = tx.get("SELECT * FROM personal_workspace WHERE singleton=1")!;
      }
      this.#workspace = LocalContextSchema.parse({ org_id: row.org_id, project_id: row.project_id,
        principal: { type: row.principal_type, id: row.principal_id } });
      const previous = tx.get("SELECT epoch FROM runtime_incarnation WHERE singleton=1");
      const epoch = previous ? Number(previous.epoch) + 1 : 0;
      if (!Number.isSafeInteger(epoch)) fail("RUNTIME_OWNER_MISMATCH");
      this.#owner = { engine: "local", instance_id: randomUUID(), epoch };
      tx.run(`INSERT INTO runtime_incarnation VALUES (1,?,?) ON CONFLICT(singleton)
        DO UPDATE SET instance_id=excluded.instance_id,epoch=excluded.epoch`, this.#owner.instance_id, epoch);
    });
  }

  /** Creation seam for a domain repository, within its own creation transaction. */
  static createFence(tx: SqliteUnit, context: LocalContext, resourceKey: string, hash: string): void {
    new ProjectRepository(tx, context);
    tx.run("INSERT INTO resource_fences VALUES (?,?,?,0,?)", context.org_id, context.project_id,
      LocalIdSchema.parse(resourceKey), LocalHashSchema.parse(hash));
  }

  /** Atomic DB write + revision CAS + durable response reference. This does not
   * authorize effects, implement jobs/Run ownership transfer or exactly-once I/O.
   * Caller performs live domain/Policy checks inside work, using the same unit.
   * Persist only a redacted opaque result reference, never payloads/credentials.
   */
  commit(input: FencedCommit, work: (tx: SqliteUnit, projects: ProjectRepository) => string): {
    replayed: boolean; resultRef: string;
  } {
    const h = LocalCommandHeaderSchema.parse(input.header);
    const trusted = LocalContextSchema.parse(input.trustedContext);
    if (h.context.org_id !== trusted.org_id || h.context.project_id !== trusted.project_id
        || h.context.principal.type !== trusted.principal.type || h.context.principal.id !== trusted.principal.id
        || (h.run && h.run.project_id !== trusted.project_id)) return fail("CONTEXT_MISMATCH");
    const command = LocalIdSchema.parse(input.command), key = LocalIdSchema.parse(input.resourceKey);
    const nextHash = LocalHashSchema.parse(input.nextHash);
    if (typeof input.canonicalContent !== "string" || Buffer.byteLength(input.canonicalContent) > 1024 * 1024)
      return fail("INVALID_PAYLOAD");
    // Bind service canonical bytes and operation identity. request_id identifies
    // attempts; host owner is checked live below, allowing authenticated recovery
    // after restart. Neither belongs to content identity. No raw bytes persist.
    const contentHash = createHash("sha256").update(JSON.stringify([
      h.schema_version, trusted.org_id, trusted.project_id, trusted.principal.type, trusted.principal.id,
      command, key, h.expected.revision, h.expected.hash, h.run, input.canonicalContent, nextHash,
    ])).digest("hex");
    return this.transaction((tx) => {
      const projects = new ProjectRepository(tx, trusted);
      const owner = tx.get("SELECT instance_id,epoch FROM runtime_incarnation WHERE singleton=1")!;
      if (h.runtime_owner.engine !== "local" || h.runtime_owner.instance_id !== owner.instance_id
          || h.runtime_owner.epoch !== owner.epoch) fail("RUNTIME_OWNER_MISMATCH");
      const scope = [trusted.org_id, trusted.project_id, trusted.principal.type, trusted.principal.id, command, h.idempotency_key];
      const replay = tx.get(`SELECT content_hash,result_ref FROM command_commits WHERE org_id=? AND project_id=?
        AND principal_type=? AND principal_id=? AND command=? AND idempotency_key=?`, ...scope);
      if (replay) {
        if (replay.content_hash !== contentHash) fail("REVISION_CONFLICT");
        return { replayed: true, resultRef: String(replay.result_ref) };
      }
      const expected = LocalVersionPinSchema.parse(h.expected);
      if (expected.revision === Number.MAX_SAFE_INTEGER) fail("REVISION_CONFLICT");
      const changed = tx.run(`UPDATE resource_fences SET revision=revision+1,hash=?
        WHERE org_id=? AND project_id=? AND resource_key=? AND revision=? AND hash=?`,
      nextHash, trusted.org_id, trusted.project_id, key, expected.revision, expected.hash);
      if (changed.changes !== 1) fail("REVISION_CONFLICT");
      const resultRef = LocalIdSchema.parse(synchronous(() => work(tx, projects)));
      tx.run("INSERT INTO command_commits VALUES (?,?,?,?,?,?,?,?)", ...scope, contentHash, resultRef);
      return { replayed: false, resultRef };
    });
  }

  /** VACUUM INTO includes committed WAL contents; never copy an open main file.
   * A new host-chosen path is mandatory. Restore offline into a fresh profile.
   */
  backup(destination: string): void {
    this.check();
    if (this.#transaction) return fail("SQLITE_BACKUP_IN_TRANSACTION");
    const path = resolve(destination);
    try {
      lstatSync(path);
      return fail("SQLITE_BACKUP_EXISTS");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let stagingDirectory: string;
    try {
      stagingDirectory = mkdtempSync(join(dirname(path), ".orchestrion-backup-"));
      const stagingStat = lstatSync(stagingDirectory, { bigint: true });
      if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()
          || (stagingStat.mode & 0o777n) !== 0o700n) throw new Error("backup staging directory invalid");
    } catch {
      return fail("SQLITE_BACKUP_FAILED");
    }
    const stagingPath = join(stagingDirectory, "snapshot.sqlite");
    let fd: number;
    try {
      fd = openSync(stagingPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    } catch {
      try { rmSync(stagingDirectory, { recursive: true }); } catch { /* No snapshot data exists yet. */ }
      return fail("SQLITE_BACKUP_FAILED");
    }
    let identity: FileIdentity;
    try {
      const created = fstatSync(fd, { bigint: true });
      if (!created.isFile() || created.nlink !== 1n) throw new Error("backup file invalid");
      identity = { dev: created.dev, ino: created.ino };
    } catch {
      return failStagedBackup(stagingDirectory, fd, "SQLITE_BACKUP_FAILED");
    }
    try {
      fchmodSync(fd, 0o600);
      validateBackupFile(stagingPath, fd, identity, false);
    } catch {
      return failStagedBackup(stagingDirectory, fd, "SQLITE_BACKUP_PERMISSION_FAILED");
    }
    try { this.db.prepare("VACUUM INTO ?").run(stagingPath); }
    catch { return failStagedBackup(stagingDirectory, fd, "SQLITE_BACKUP_FAILED"); }
    try {
      fchmodSync(fd, 0o600);
      validateBackupFile(stagingPath, fd, identity, true);
      const verified = new DatabaseSync(stagingPath, { readOnly: true });
      try {
        if (verified.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok"
            || verified.prepare("PRAGMA foreign_key_check").all().length) throw new Error("backup integrity invalid");
      } finally { verified.close(); }
      validateBackupFile(stagingPath, fd, identity, true);
    } catch {
      return failStagedBackup(stagingDirectory, fd, "SQLITE_BACKUP_PERMISSION_FAILED");
    }
    try {
      // Atomic publication: link either binds this verified inode at the trusted
      // destination or fails without overwriting an existing/replaced path.
      linkSync(stagingPath, path);
    } catch (error) {
      return failStagedBackup(stagingDirectory, fd,
        (error as NodeJS.ErrnoException).code === "EEXIST" ? "SQLITE_BACKUP_EXISTS" : "SQLITE_BACKUP_FAILED");
    }
    try {
      validateBackupFile(path, fd, identity, true, [2n]);
    } catch {
      return failPublishedBackup(stagingDirectory, fd, "SQLITE_BACKUP_PERMISSION_FAILED");
    }
    try { rmSync(stagingDirectory, { recursive: true }); } catch {
      return failRetainedPublishedBackup(fd, "SQLITE_BACKUP_CLEANUP_FAILED");
    }
    let stagingRemains = false;
    try { lstatSync(stagingDirectory); stagingRemains = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") stagingRemains = true;
    }
    if (stagingRemains) return failRetainedPublishedBackup(fd, "SQLITE_BACKUP_CLEANUP_FAILED");
    try {
      validateBackupFile(path, fd, identity, true, [1n]);
    } catch {
      return failRetainedPublishedBackup(fd, "SQLITE_BACKUP_PERMISSION_FAILED");
    }
    try { closeSync(fd); } catch { return fail("SQLITE_BACKUP_CLEANUP_FAILED"); }
  }

  /** Offline maintenance only. Deletes foundation data only if every migration
   * permits downgrade; credential metadata (including tombstones) blocks it.
   * Always closes the host, including after an atomic migration refusal. */
  downgradeToEmpty(): void {
    this.check();
    if (this.#transaction) return fail("SQLITE_NESTED_TRANSACTION_DENIED");
    try { migrate(this.db, 0); } finally { this.close(); }
  }
  close(): void {
    if (this.#closed) return;
    if (this.#transaction) return fail("SQLITE_CLOSE_IN_TRANSACTION");
    try { this.db.close(); } finally { this.writer.close(); this.#closed = true; }
  }
}
