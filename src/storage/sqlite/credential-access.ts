import type { SqliteUnit } from "./foundation";
import { credentialFail, CredentialScopeSchema, credentialParse, type CredentialScope } from "./credential-metadata";

/** Host lifecycle access queries. No secret, Keychain I/O or schema changes. */
export class CredentialAccessRepository {
  readonly #scope: CredentialScope;
  constructor(private readonly tx: SqliteUnit, scope: CredentialScope) {
    this.#scope = credentialParse(CredentialScopeSchema, scope);
  }
  requireMembership(): void {
    const c = this.#scope;
    if (!this.tx.get("SELECT 1 FROM memberships WHERE org_id=? AND principal_type=? AND principal_id=?",
      c.org_id, c.principal.type, c.principal.id)) credentialFail("UNAVAILABLE");
  }
  exists(ref: string): boolean {
    this.requireMembership();
    const c = this.#scope;
    return !!this.tx.get("SELECT 1 FROM credential_metadata WHERE org_id=? AND principal_type=? AND principal_id=? AND credential_ref=?",
      c.org_id, c.principal.type, c.principal.id, ref);
  }
}
