import { randomUUID } from "node:crypto";
import { LOCAL_CONTRACT_VERSION, type LocalContext, type RuntimeOwner } from "../shared/local-contracts";
import { CursorSchema, JobEventSchema, type Cursor } from "../shared/realtime-contracts";
import { ProjectRepository, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";

/** All queries include the trusted principal as well as org/project/subject. */
export class EventRepository {
  private readonly scope: string[];
  private readonly where = "org_id=? AND project_id=? AND principal_type=? AND principal_id=? AND subject_id=?";
  constructor(private readonly tx: SqliteUnit, private readonly context: LocalContext) {
    new ProjectRepository(tx, context);
    this.scope = [context.org_id, context.project_id, context.principal.type, context.principal.id];
  }
  version(resourceKey: string) {
    const row = this.tx.get("SELECT revision,hash FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",
      this.context.org_id, this.context.project_id, resourceKey);
    if (!row) throw new StorageError("NOT_AUTHENTICATED");
    return { revision: Number(row.revision), hash: String(row.hash) };
  }
  append(subject: string, status: string): void {
    if (!this.tx.get("SELECT 1 FROM local_jobs WHERE org_id=? AND project_id=? AND principal_type=? AND principal_id=? AND id=?",
      ...this.scope, subject)) throw new StorageError("NOT_AUTHENTICATED");
    const last = this.latest(subject);
    if (last?.status === status) return;
    this.tx.run(`INSERT INTO local_job_events(event_id,org_id,project_id,principal_type,principal_id,subject_id,ordinal,status,timestamp)
      VALUES (?,?,?,?,?,?,?,?,?)`, randomUUID(), ...this.scope, subject, Number(last?.ordinal ?? 0) + 1, status, new Date().toISOString());
  }
  private latest(subject: string) {
    return this.tx.get(`SELECT * FROM local_job_events WHERE ${this.where} ORDER BY sequence DESC LIMIT 1`, ...this.scope, subject);
  }
  private cursor(row: Record<string, unknown>): Cursor {
    return CursorSchema.parse({ version: "synthetic.cursor.v1", context: this.context, subject_id: row.subject_id,
      sequence: row.sequence, ordinal: row.ordinal, event_id: row.event_id });
  }
  private event(row: Record<string, unknown>, owner: RuntimeOwner) {
    return JobEventSchema.parse({ schema_version: LOCAL_CONTRACT_VERSION, context: this.context, runtime_owner: owner,
      revision: row.ordinal, request_id: row.event_id, causation_id: row.event_id, event_id: row.event_id,
      event_type: "synthetic.job.status", channel: "domain", run: null, node_id: null, recorded_sequence: row.sequence,
      timestamp: row.timestamp, data: { subject_id: row.subject_id, ordinal: row.ordinal, status: row.status } });
  }
  snapshot(subject: string, owner: RuntimeOwner) {
    const row = this.latest(subject);
    if (!row) throw new StorageError("NOT_AUTHENTICATED");
    return { event: this.event(row, owner), cursor: this.cursor(row) };
  }
  page(subject: string, cursor: Cursor | null, limit: number, owner: RuntimeOwner) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new StorageError("INVALID_PAYLOAD");
    this.snapshot(subject, owner); // uniform failure for foreign and absent subjects
    if (cursor) {
      cursor = CursorSchema.parse(cursor);
      if (JSON.stringify(cursor.context) !== JSON.stringify(this.context) || cursor.subject_id !== subject)
        throw new StorageError("INVALID_PAYLOAD");
      const anchor = this.tx.get(`SELECT 1 FROM local_job_events WHERE ${this.where} AND sequence=? AND ordinal=? AND event_id=?`,
        ...this.scope, subject, cursor.sequence, cursor.ordinal, cursor.event_id);
      if (!anchor) throw new StorageError("INVALID_PAYLOAD");
    }
    const rows = this.tx.all(`SELECT * FROM local_job_events WHERE ${this.where} AND sequence>? ORDER BY sequence LIMIT ?`,
      ...this.scope, subject, cursor?.sequence ?? 0, limit + 1);
    let ordinal = cursor?.ordinal ?? 0;
    for (const row of rows) if (row.ordinal !== ++ordinal) throw new StorageError("INVALID_PAYLOAD");
    const page = rows.slice(0, limit);
    return { events: page.map(r => this.event(r, owner)), cursor: page.length ? this.cursor(page[page.length - 1]) : cursor, has_more: rows.length > limit };
  }
}
