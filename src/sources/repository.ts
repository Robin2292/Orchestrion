import type { LocalContext } from "../shared/local-contracts";
import { SourceSnapshotSchema, SourcePublicationSchema, type SourceSnapshot, type SourcePublication } from "../shared/source-publication-contracts";
import { canonical, type Json } from "../shared/policy/p0-canonical";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";

export const SOURCE_FENCE = "local-source-publications";
export class SourceRepository {
  private readonly scope: string[];
  private readonly where = "org_id=? AND project_id=? AND principal_type=? AND principal_id=?";
  constructor(private readonly tx: SqliteUnit, readonly context: LocalContext) {
    this.scope=[context.org_id,context.project_id,context.principal.type,context.principal.id];
  }
  authorize(write=false) {
    const row=this.tx.get("SELECT role FROM memberships WHERE org_id=? AND principal_type=? AND principal_id=?",
      this.context.org_id,this.context.principal.type,this.context.principal.id);
    if (!row || !(write ? ["owner","admin"] : ["owner","admin","editor","viewer"]).includes(String(row.role)))
      throw new StorageError("NOT_AUTHENTICATED");
  }
  ensureFence() {
    if (!this.tx.get("SELECT 1 FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",
      this.context.org_id,this.context.project_id,SOURCE_FENCE))
      SqliteFoundation.createFence(this.tx,this.context,SOURCE_FENCE,`sha256:${"0".repeat(64)}`);
  }
  pin() {
    const row=this.tx.get("SELECT revision,hash FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",
      this.context.org_id,this.context.project_id,SOURCE_FENCE)!;
    return { revision:Number(row.revision),hash:String(row.hash) };
  }
  snapshot(id:string): SourceSnapshot {
    const row=this.tx.get(`SELECT snapshot_json,content_hash FROM local_source_snapshots WHERE ${this.where} AND id=?`,...this.scope,id);
    if (!row) throw new StorageError("SOURCE_NOT_FOUND");
    const value=SourceSnapshotSchema.parse(JSON.parse(String(row.snapshot_json)));
    if (value.contentHash!==row.content_hash || canonical(value.context)!==canonical(this.context)) throw new StorageError("SOURCE_CORRUPT");
    return value;
  }
  insertSnapshot(value:SourceSnapshot) {
    this.tx.run("INSERT INTO local_source_snapshots VALUES (?,?,?,?,?,?,?, ?,?)",
      ...this.scope,value.id,value.sourceId,value.contentHash,canonical(value as unknown as Json),value.acceptedAt);
  }
  latestSnapshot(connectorId:string): SourceSnapshot | null {
    const row=this.tx.get(`SELECT id FROM local_source_snapshots WHERE ${this.where} AND connector_id=? ORDER BY rowid DESC LIMIT 1`,...this.scope,connectorId);
    return row ? this.snapshot(String(row.id)) : null;
  }
  insertDraft(id:string,snapshot:SourceSnapshot,now:string) {
    this.tx.run("INSERT INTO local_source_drafts VALUES (?,?,?,?,?,?,?,?,?,?)",
      ...this.scope,id,snapshot.sourceId,snapshot.id,null,now,null);
  }
  draft(id:string) {
    const row=this.tx.get(`SELECT connector_id,snapshot_id,reviewed_hash,reviewed_at FROM local_source_drafts WHERE ${this.where} AND id=?`,...this.scope,id);
    if (!row) throw new StorageError("SOURCE_DRAFT_NOT_FOUND");
    return { connectorId:String(row.connector_id),snapshotId:String(row.snapshot_id),reviewedHash:row.reviewed_hash===null ? null : String(row.reviewed_hash),
      reviewedAt:row.reviewed_at===null ? null : String(row.reviewed_at) };
  }
  review(id:string,hash:string,now:string) {
    const result=this.tx.run(`UPDATE local_source_drafts SET reviewed_hash=?,reviewed_at=? WHERE ${this.where} AND id=? AND reviewed_at IS NULL`,
      hash,now,...this.scope,id);
    if (result.changes!==1) throw new StorageError("SOURCE_DRAFT_FROZEN");
  }
  release(id:string): SourcePublication {
    const row=this.tx.get(`SELECT publication_json,content_hash FROM local_source_releases WHERE ${this.where} AND id=?`,...this.scope,id);
    if (!row) throw new StorageError("SOURCE_RELEASE_NOT_FOUND");
    const value=SourcePublicationSchema.parse(JSON.parse(String(row.publication_json)));
    if (value.snapshotHash!==row.content_hash || canonical(value.context)!==canonical(this.context)) throw new StorageError("SOURCE_CORRUPT");
    return value;
  }
  nextVersion(connectorId:string) {
    const row=this.tx.get(`SELECT coalesce(max(version),0) AS version FROM local_source_releases WHERE ${this.where} AND connector_id=?`,...this.scope,connectorId)!;
    const version=Number(row.version)+1;
    if (!Number.isSafeInteger(version)) throw new StorageError("SOURCE_VERSION_EXHAUSTED");
    return version;
  }
  insertRelease(value:SourcePublication,draftId:string) {
    this.tx.run("INSERT INTO local_source_releases VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ...this.scope,value.id,value.sourceId,value.version,draftId,value.snapshotId,value.snapshotHash,canonical(value as unknown as Json),value.publishedAt);
  }
  latestRelease(connectorId:string): SourcePublication | null {
    const row=this.tx.get(`SELECT id FROM local_source_releases WHERE ${this.where} AND connector_id=? ORDER BY version DESC LIMIT 1`,...this.scope,connectorId);
    return row ? this.release(String(row.id)) : null;
  }
  active(connectorId:string) {
    const row=this.tx.get(`SELECT release_id,revision FROM local_source_activation_events WHERE ${this.where} AND connector_id=? ORDER BY revision DESC LIMIT 1`,...this.scope,connectorId);
    return row ? { releaseId:String(row.release_id),revision:Number(row.revision) } : null;
  }
  activate(value:SourcePublication,now:string) {
    const next=(this.active(value.sourceId)?.revision ?? 0)+1;
    if (!Number.isSafeInteger(next)) throw new StorageError("SOURCE_VERSION_EXHAUSTED");
    this.tx.run("INSERT INTO local_source_activation_events VALUES (?,?,?,?,?,?,?,?)",...this.scope,value.sourceId,next,value.id,now);
  }
}
