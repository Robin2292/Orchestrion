import type { LocalContext } from "../shared/local-contracts";
import { LocalConnectorSchema, type LocalConnector } from "../shared/connector-contracts";
import { CredentialMetadataRepository } from "../storage/sqlite/credential-metadata";
import { SqliteFoundation, StorageError, type SqliteUnit } from "../storage/sqlite/foundation";
import { canonical } from "../shared/policy/p0-canonical";

export const CONNECTOR_FENCE = "local-connectors";
export class ConnectorRepository {
  private readonly scope: string[];
  private readonly where = "org_id=? AND project_id=? AND principal_type=? AND principal_id=?";
  readonly credentials: CredentialMetadataRepository;
  constructor(private readonly tx: SqliteUnit, readonly context: LocalContext) {
    this.credentials = new CredentialMetadataRepository(tx,{ org_id:context.org_id,principal:context.principal });
    this.scope = [context.org_id,context.project_id,context.principal.type,context.principal.id];
  }
  authorize(write = false) {
    const row = this.tx.get("SELECT role FROM memberships WHERE org_id=? AND principal_type=? AND principal_id=?",
      this.context.org_id,this.context.principal.type,this.context.principal.id);
    const roles = write ? ["owner","admin"] : ["owner","admin","editor","viewer"];
    if (!row || !roles.includes(String(row.role))) throw new StorageError("NOT_AUTHENTICATED");
  }
  ensureFence() {
    const c = this.context;
    if (!this.tx.get("SELECT 1 FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",c.org_id,c.project_id,CONNECTOR_FENCE))
      SqliteFoundation.createFence(this.tx,c,CONNECTOR_FENCE,`sha256:${"0".repeat(64)}`);
  }
  pin() {
    const c = this.context, row = this.tx.get("SELECT revision,hash FROM resource_fences WHERE org_id=? AND project_id=? AND resource_key=?",c.org_id,c.project_id,CONNECTOR_FENCE)!;
    return { revision:Number(row.revision),hash:String(row.hash) };
  }
  get(id: string): LocalConnector {
    const r = this.tx.get(`SELECT * FROM local_connectors WHERE ${this.where} AND id=?`,...this.scope,id);
    if (!r) throw new StorageError("CONNECTOR_NOT_FOUND");
    return LocalConnectorSchema.parse({ schemaVersion:"orchestrion.local.connector.v1",context:this.context,
      id:r.id,revision:r.revision,config:JSON.parse(String(r.config_json)),auth:JSON.parse(String(r.auth_json)),
      origin:r.origin,status:r.status,cleanupRequired:!!r.cleanup_required,createdAt:r.created_at,updatedAt:r.updated_at,deletedAt:r.deleted_at });
  }
  list(limit: number, offset: number) {
    return this.tx.all(`SELECT id FROM local_connectors WHERE ${this.where} AND deleted_at IS NULL ORDER BY created_at,id LIMIT ? OFFSET ?`,...this.scope,limit,offset)
      .map((r) => this.get(String(r.id)));
  }
  requireName(name: string, id: string) {
    if (this.tx.get(`SELECT 1 FROM local_connectors WHERE ${this.where} AND name=? AND id!=? AND deleted_at IS NULL`,...this.scope,name,id))
      throw new StorageError("CONNECTOR_CONFLICT");
  }
  insert(c: LocalConnector) {
    const result = this.tx.run("INSERT INTO local_connectors VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      ...this.scope,c.id,c.revision,c.config.name,canonical(c.config),c.origin,canonical(c.auth),c.status,Number(c.cleanupRequired),c.createdAt,c.updatedAt,c.deletedAt);
    if (result.changes !== 1) throw new StorageError("CONNECTOR_CONFLICT");
  }
  replace(c: LocalConnector) {
    const result = this.tx.run(`UPDATE local_connectors SET revision=?,name=?,config_json=?,auth_json=?,cleanup_required=?,updated_at=?,deleted_at=?
      WHERE ${this.where} AND id=? AND revision=? AND deleted_at IS NULL`,
    c.revision,c.config.name,canonical(c.config),canonical(c.auth),Number(c.cleanupRequired),c.updatedAt,c.deletedAt,...this.scope,c.id,c.revision-1);
    if (result.changes !== 1) throw new StorageError("CONNECTOR_REVISION_CONFLICT");
  }
  bind(c: LocalConnector) {
    if (c.auth.mode !== "static") return;
    const p = c.auth.credential;
    this.tx.run("INSERT INTO local_connector_auth_bindings VALUES (?,?,?,?,?,?,?,?)",...this.scope,c.id,c.revision,p.credential_ref,p.revision);
  }
  bindings(id: string) {
    return this.tx.all(`SELECT credential_ref,credential_revision FROM local_connector_auth_bindings WHERE ${this.where} AND connector_id=? ORDER BY connector_revision`,...this.scope,id)
      .map((r) => ({ connector_id:id,credential_ref:String(r.credential_ref),revision:Number(r.credential_revision) }));
  }
  credentialStates(id: string) {
    // Includes committed but unbound references. Uncommitted staging is separate.
    const c = this.context;
    return this.tx.all("SELECT credential_ref FROM credential_metadata WHERE org_id=? AND principal_type=? AND principal_id=? AND connector_id=? ORDER BY credential_ref",
      c.org_id,c.principal.type,c.principal.id,id).map((r) => {
      const row = this.credentials.get({ connector_id:id,credential_ref:String(r.credential_ref) });
      return { connector_id:id,credential_ref:row.credential_ref,revision:row.revision,state:row.state };
    });
  }
  staging(id: string) {
    const c = this.context;
    return this.tx.all(`SELECT credential_ref,revision,state FROM credential_staging WHERE org_id=? AND principal_type=? AND principal_id=? AND connector_id=?`,
      c.org_id,c.principal.type,c.principal.id,id);
  }
  tombstone(c: LocalConnector, proofRef: string) {
    this.tx.run("INSERT INTO local_connector_tombstones VALUES (?,?,?,?,?,?,?,?)",...this.scope,c.id,c.revision,proofRef,c.deletedAt);
  }
}
