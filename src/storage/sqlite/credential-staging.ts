import type { SqliteUnit } from "./foundation";
import { CredentialAccessRepository } from "./credential-access";
import { credentialFail, type CredentialPin, type CredentialScope } from "./credential-metadata";

/** Non-secret F5 write-ahead obligations. A cleared identity/version is retained
 * to reject replay; only F5's authoritative external cleanup may clear pending.
 * Connector IDs are globally unique; C0 supplies the project permission fence.
 */
export class CredentialStagingRepository {
  constructor(private readonly tx: SqliteUnit, private readonly scope: CredentialScope) {}
  private args(p: CredentialPin) {
    new CredentialAccessRepository(this.tx,this.scope).requireMembership();
    return [this.scope.org_id,this.scope.principal.type,this.scope.principal.id,p.connector_id,p.credential_ref,p.revision];
  }
  state(p: CredentialPin): "pending" | "published" | "cleared" | null {
    const row = this.tx.get(`SELECT state FROM credential_staging WHERE org_id=? AND principal_type=? AND principal_id=?
      AND connector_id=? AND credential_ref=? AND revision=?`,...this.args(p));
    return row ? row.state as "pending" | "published" | "cleared" : null;
  }
  stage(p: CredentialPin): void {
    const result = this.tx.run("INSERT INTO credential_staging VALUES (?,?,?,?,?,?,'pending') ON CONFLICT DO NOTHING",...this.args(p));
    if (result.changes !== 1) credentialFail("CONFLICT");
  }
  finish(p: CredentialPin, state: "published" | "cleared"): void {
    const result = this.tx.run(`UPDATE credential_staging SET state=? WHERE org_id=? AND principal_type=? AND principal_id=?
      AND connector_id=? AND credential_ref=? AND revision=? AND state='pending'`,state,...this.args(p));
    if (result.changes !== 1) credentialFail("CONFLICT");
  }
}
