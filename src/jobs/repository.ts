import { EventRepository } from "../realtime/repository";
import { LocalContextSchema, type LocalContext, type RuntimeOwner } from "../shared/local-contracts";
import { ProjectRepository, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { LEASE_MS, retryDelay, type Claim, type JobStatus, type SyntheticJob } from "./model";

/** Internal scoped repository; never exposed to renderer, model, or adapter. */
export class JobRepository {
  changed = false;
  private fact(id: string, status: JobStatus): void {
    new EventRepository(this.tx, this.c).append(id, status);
    this.changed = true;
  }
  private readonly c: LocalContext;
  private readonly scope: string[];
  constructor(private readonly tx: SqliteUnit, context: LocalContext) {
    this.c = LocalContextSchema.parse(context);
    new ProjectRepository(tx, this.c);
    this.scope = [this.c.org_id, this.c.project_id, this.c.principal.type, this.c.principal.id];
  }
  private readonly where = "org_id=? AND project_id=? AND principal_type=? AND principal_id=?";
  get(id: string) { return this.tx.get(`SELECT * FROM local_jobs WHERE ${this.where} AND id=?`, ...this.scope, id); }
  insert(id: string, job: SyntheticJob, now: number): void {
    this.tx.run(`INSERT INTO local_jobs
      (org_id,project_id,principal_type,principal_id,id,mode,status,max_attempts,available_at)
      VALUES (?,?,?,?,?,?,'queued',?,?)`, ...this.scope, id, job.mode, job.maxAttempts, now);
    this.tx.run("INSERT INTO local_job_outbox VALUES (?,?,?)", this.c.org_id, this.c.project_id, id);
    this.fact(id, "queued");
  }
  private liveOwner(owner: RuntimeOwner): void {
    const row = this.tx.get("SELECT instance_id,epoch FROM runtime_incarnation WHERE singleton=1")!;
    if (owner.engine !== "local" || row.instance_id !== owner.instance_id || row.epoch !== owner.epoch)
      throw new StorageError("RUNTIME_OWNER_MISMATCH");
  }
  private owns(claim: Claim, now: number, status: string) {
    this.liveOwner(claim.owner);
    const r = this.get(claim.id);
    return r && r.status === status && r.epoch === claim.epoch && r.owner_instance === claim.owner.instance_id
      && r.owner_epoch === claim.owner.epoch && Number(r.lease_until) > now ? r : undefined;
  }
  private state(id: string, status: JobStatus, availableAt?: number): void {
    this.tx.run(`UPDATE local_jobs SET status=?,owner_instance=NULL,owner_epoch=NULL,lease_until=NULL
      ${availableAt === undefined ? "" : ",available_at=?"} WHERE ${this.where} AND id=?`,
    status, ...(availableAt === undefined ? [] : [availableAt]), ...this.scope, id);
    this.fact(id, status);
    if (status !== "queued") this.tx.run("DELETE FROM local_job_outbox WHERE org_id=? AND project_id=? AND job_id=?",
      this.c.org_id, this.c.project_id, id);
  }
  private receipt(id: string): boolean {
    return !!this.tx.get("SELECT 1 FROM local_synthetic_effects WHERE org_id=? AND project_id=? AND job_id=?",
      this.c.org_id, this.c.project_id, id);
  }
  /** Bounded expiry scan. An uncertain effect is never eligible for redispatch. */
  recover(now: number, limit = 8): void {
    const rows = this.tx.all(`SELECT * FROM local_jobs WHERE ${this.where}
      AND status IN ('claimed','effect') AND lease_until<=? ORDER BY lease_until,id LIMIT ?`, ...this.scope, now, limit);
    for (const r of rows) {
      const id = String(r.id);
      if (r.status === "effect") this.state(id, this.receipt(id) ? "succeeded" : "unknown");
      else this.state(id, Number(r.attempts) >= Number(r.max_attempts) ? "failed" : "queued",
        now + retryDelay(Number(r.attempts)));
    }
  }
  claim(owner: RuntimeOwner, now: number): Claim | null {
    this.liveOwner(owner);
    const r = this.tx.get(`SELECT j.* FROM local_jobs j JOIN local_job_outbox o
      ON o.org_id=j.org_id AND o.project_id=j.project_id AND o.job_id=j.id
      WHERE j.org_id=? AND j.project_id=? AND j.principal_type=? AND j.principal_id=?
      AND j.status='queued' AND j.available_at<=? AND j.attempts<j.max_attempts
      ORDER BY j.available_at,j.id LIMIT 1`, ...this.scope, now);
    if (!r) return null;
    const epoch = Number(r.epoch) + 1;
    if (!Number.isSafeInteger(epoch)) throw new StorageError("JOB_EPOCH_EXHAUSTED");
    this.tx.run(`UPDATE local_jobs SET status='claimed',attempts=attempts+1,epoch=?,owner_instance=?,owner_epoch=?,lease_until=?
      WHERE ${this.where} AND id=? AND status='queued'`, epoch, owner.instance_id, owner.epoch, now + LEASE_MS, ...this.scope, r.id);
    this.fact(String(r.id), "claimed");
    return { id: String(r.id), epoch, owner: { ...owner }, mode: r.mode as SyntheticJob["mode"], attempts: Number(r.attempts) + 1 };
  }
  begin(claim: Claim, now: number): boolean {
    if (!this.owns(claim, now, "claimed")) return false;
    this.tx.run(`UPDATE local_jobs SET status='effect' WHERE ${this.where} AND id=?`, ...this.scope, claim.id);
    this.fact(claim.id, "effect");
    return true;
  }
  /** The only executable effect: a fixed DB marker. No injected external executor. */
  confirmSynthetic(claim: Claim, now: number): boolean {
    const row = this.owns(claim, now, "effect");
    if (!row || row.mode !== "success") return false;
    return this.tx.run("INSERT OR IGNORE INTO local_synthetic_effects VALUES (?,?,?,'synthetic-confirmed')",
      this.c.org_id, this.c.project_id, claim.id).changes === 1;
  }
  finish(claim: Claim, now: number): boolean {
    if (!this.owns(claim, now, "effect")) return false;
    this.state(claim.id, this.receipt(claim.id) ? "succeeded" : "unknown");
    return true;
  }
  retry(claim: Claim, now: number): boolean {
    const row = this.owns(claim, now, "claimed");
    if (!row) return false; // retry only before effect admission
    this.state(claim.id, Number(row.attempts) >= Number(row.max_attempts) ? "failed" : "queued",
      now + retryDelay(Number(row.attempts)));
    return true;
  }
  cancel(id: string): JobStatus | null {
    const row = this.get(id);
    if (!row) return null;
    // Transaction order wins. An already-started effect cannot promise cancellation.
    if (row.status === "effect") this.state(id, "unknown");
    else if (row.status === "queued" || row.status === "claimed") this.state(id, "cancelled");
    return this.get(id)!.status as JobStatus;
  }
  stop(owner: RuntimeOwner, now: number): void {
    this.liveOwner(owner);
    // A worker owns at most one claim; shutdown never takes another worker's lease.
    const rows = this.tx.all(`SELECT * FROM local_jobs WHERE ${this.where} AND owner_instance=? AND owner_epoch=?
      AND status IN ('claimed','effect')`, ...this.scope, owner.instance_id, owner.epoch);
    for (const r of rows) {
      if (r.status === "effect") this.state(String(r.id), this.receipt(String(r.id)) ? "succeeded" : "unknown");
      else this.state(String(r.id), Number(r.attempts) >= Number(r.max_attempts) ? "failed" : "queued",
        now + retryDelay(Number(r.attempts)));
    }
  }
}
