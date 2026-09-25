import { LocalContextSchema, type LocalContext, type RuntimeOwner } from "../../shared/local-contracts";
import { GovernedToolEventInputSchema, type GovernedToolEventInput } from "../../shared/governed-tool-contracts";
import { ProjectRepository, StorageError, type SqliteUnit } from "./foundation";

/** Scoped SQL for migration 10. Rows are append-only audit evidence bound to an
 * execution attempt; the schema enforces ordering, immutability and retention. */
export class GovernedToolEventRepository {
  readonly context: LocalContext;
  private readonly scope: string[];
  private readonly where = "org_id=? AND project_id=? AND principal_type=? AND principal_id=?";
  constructor(private readonly tx: SqliteUnit, context: LocalContext) {
    this.context = LocalContextSchema.parse(context);
    new ProjectRepository(tx, this.context);
    const c = this.context;
    this.scope = [c.org_id, c.project_id, c.principal.type, c.principal.id];
  }
  /** Idempotency probe: any recorded row for this attempt/call id, admitted or denied. */
  has(attemptId: string, callId: string): boolean {
    return !!this.tx.get(`SELECT 1 FROM local_governed_tool_events WHERE ${this.where} AND attempt_id=? AND call_id=? LIMIT 1`, ...this.scope, attemptId, callId);
  }
  insert(raw: unknown, owner: RuntimeOwner): void {
    let e: GovernedToolEventInput;
    try { e = GovernedToolEventInputSchema.parse(raw); } catch { throw new StorageError("INVALID_PAYLOAD"); }
    const ordinal = e.event_type === "admitted" || e.event_type === "denied" ? 1 : 2;
    this.tx.run(`INSERT INTO local_governed_tool_events (event_id,org_id,project_id,principal_type,principal_id,session_id,attempt_id,thread_id,turn_id,call_id,
      tool_name,ordinal,event_type,reason_code,plan_hash,result_hash,result_bytes,request_id,causation_id,owner_instance_id,owner_epoch,timestamp,data_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, e.event_id, ...this.scope, e.session_id, e.attempt_id, e.thread_id, e.turn_id, e.call_id,
    e.tool_name, ordinal, e.event_type, e.reason_code, e.plan_hash, e.result_hash, e.result_bytes, e.request_id, e.causation_id,
    owner.instance_id, owner.epoch, e.timestamp, JSON.stringify(e.data));
  }
  forSession(sessionId: string) {
    return this.tx.all(`SELECT sequence,event_id,attempt_id,thread_id,turn_id,call_id,tool_name,ordinal,event_type,reason_code,plan_hash,result_hash,result_bytes,
      request_id,causation_id,owner_instance_id,owner_epoch,timestamp,data_json FROM local_governed_tool_events WHERE ${this.where} AND session_id=? ORDER BY sequence`,
    ...this.scope, sessionId);
  }
}
