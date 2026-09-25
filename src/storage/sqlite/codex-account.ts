import { z } from "zod";
import type { SqliteUnit } from "./foundation";
import { credentialFail, credentialParse, CredentialScopeSchema, type CredentialScope } from "./credential-metadata";

const id = z.string().uuid();
const accountId = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/);

/** SQLite owns only the non-secret account pin and recovery intent. */
export class CodexAccountRepository {
  private readonly scope: CredentialScope;
  constructor(private readonly tx: SqliteUnit, scope: CredentialScope,
    private readonly projectId: string, private readonly connectorId: string) {
    this.scope = credentialParse(CredentialScopeSchema, scope);
    credentialParse(id, projectId);
    credentialParse(id, connectorId);
  }
  private args(): [string, string, string, string, string] {
    const c = this.scope;
    const args: [string, string, string, string, string] =
      [c.org_id, c.principal.type, c.principal.id, this.projectId, this.connectorId];
    if (c.principal.type !== "user" || !this.tx.get(`SELECT 1 FROM memberships m
      JOIN projects p ON p.org_id=m.org_id AND p.id=?
      WHERE m.org_id=? AND m.principal_type=? AND m.principal_id=?`,
    this.projectId, c.org_id, c.principal.type, c.principal.id)) credentialFail("UNAVAILABLE");
    return args;
  }
  begin(ref: string, verifiedAccountId: string): void {
    credentialParse(id, ref);
    const account = credentialParse(accountId, verifiedAccountId);
    const changed = this.tx.run(`INSERT INTO local_codex_oauth_accounts
      (credential_ref,org_id,principal_type,principal_id,project_id,connector_id,
       account_id,account_display,provenance,credential_revision,state)
      VALUES (?,?,?,?,?,?,?,?,'trusted_account_verifier',0,'pending') ON CONFLICT DO NOTHING`,
    ref, ...this.args(), account, account);
    if (changed.changes !== 1) credentialFail("CONFLICT");
  }
  publish(ref: string, verifiedAccountId: string): void {
    credentialParse(id, ref);
    const account = credentialParse(accountId, verifiedAccountId);
    const changed = this.tx.run(`UPDATE local_codex_oauth_accounts SET state='active'
      WHERE credential_ref=? AND org_id=? AND principal_type=? AND principal_id=?
      AND project_id=? AND connector_id=? AND account_id=? AND state='pending'`,
    ref, ...this.args(), account);
    if (changed.changes !== 1) credentialFail("UNAVAILABLE");
  }
  active(ref: string, revision: number, verifiedAccountId: string): { accountDisplay: string } {
    credentialParse(id, ref);
    if (!Number.isSafeInteger(revision) || revision < 0) credentialFail("UNAVAILABLE");
    const account = credentialParse(accountId, verifiedAccountId);
    const row = this.tx.get(`SELECT a.account_display FROM local_codex_oauth_accounts a
      JOIN credential_metadata c ON c.credential_ref=a.credential_ref AND c.org_id=a.org_id
        AND c.principal_type=a.principal_type AND c.principal_id=a.principal_id
        AND c.connector_id=a.connector_id AND c.revision=a.credential_revision AND c.state='active'
      WHERE a.credential_ref=? AND a.org_id=? AND a.principal_type=? AND a.principal_id=?
        AND a.project_id=? AND a.connector_id=? AND a.account_id=? AND a.state='active'
        AND a.pending_kind IS NULL AND a.credential_revision=?`,
    ref, ...this.args(), account, revision);
    if (!row || typeof row.account_display !== "string" || row.account_display !== account)
      credentialFail("UNAVAILABLE");
    return { accountDisplay: row.account_display };
  }
  /** Host-only lookup for the currently verified account; never return this pin to IPC. */
  latest(verifiedAccountId: string): { ref: string; revision: number; state: string } | null {
    const account = credentialParse(accountId, verifiedAccountId);
    const row = this.tx.get(`SELECT credential_ref,credential_revision,state
      FROM local_codex_oauth_accounts WHERE org_id=? AND principal_type=? AND principal_id=?
        AND project_id=? AND connector_id=? AND account_id=?
      ORDER BY rowid DESC LIMIT 1`, ...this.args(), account);
    if (!row) return null;
    return { ref: String(row.credential_ref), revision: Number(row.credential_revision),
      state: String(row.state) };
  }
  /** Include every live pin. A newer pending/active row cannot hide an older
   * credential during readiness or disconnect. Host never projects refs. */
  liveForAccount(verifiedAccountId: string): Array<{ ref: string; revision: number; state: "active" | "pending" }> {
    const account = credentialParse(accountId, verifiedAccountId);
    return this.tx.all(`SELECT credential_ref,credential_revision,state
      FROM local_codex_oauth_accounts WHERE org_id=? AND principal_type=? AND principal_id=?
        AND project_id=? AND connector_id=? AND account_id=? AND state IN ('active','pending')
      ORDER BY rowid DESC`, ...this.args(), account).map(row => ({ ref: String(row.credential_ref),
      revision: Number(row.credential_revision), state: row.state as "active" | "pending" }));
  }
  hasLive(): boolean {
    return !!this.tx.get(`SELECT 1 FROM local_codex_oauth_accounts
      WHERE org_id=? AND principal_type=? AND principal_id=? AND project_id=? AND connector_id=?
      AND state IN ('active','pending') LIMIT 1`, ...this.args());
  }
  /** Host-owned deletion scope. Account IDs originate in trusted persisted pins,
   * never in a renderer request or account-selection hint. */
  activePins(): Array<{ ref: string; revision: number; accountId: string }> {
    return this.tx.all(`SELECT credential_ref,credential_revision,account_id
      FROM local_codex_oauth_accounts WHERE org_id=? AND principal_type=? AND principal_id=?
        AND project_id=? AND connector_id=? AND state='active' ORDER BY rowid DESC`, ...this.args())
      .map(row => ({ ref: String(row.credential_ref), revision: Number(row.credential_revision),
        accountId: String(row.account_id) }));
  }
  reserve(ref: string, revision: number, verifiedAccountId: string, kind: "refresh" | "revoke"): void {
    this.active(ref, revision, verifiedAccountId);
    if (revision >= Number.MAX_SAFE_INTEGER) credentialFail("UNAVAILABLE");
    const changed = this.tx.run(`UPDATE local_codex_oauth_accounts
      SET pending_kind=?,pending_revision=credential_revision+1
      WHERE credential_ref=? AND org_id=? AND principal_type=? AND principal_id=?
        AND project_id=? AND connector_id=? AND account_id=?
        AND state='active' AND pending_kind IS NULL AND credential_revision=?`,
    kind, ref, ...this.args(), verifiedAccountId, revision);
    if (changed.changes !== 1) credentialFail("UNAVAILABLE");
  }
  requireRefresh(ref: string, revision: number, verifiedAccountId: string): void {
    credentialParse(id, ref);
    const account = credentialParse(accountId, verifiedAccountId);
    const row = this.tx.get(`SELECT 1 FROM local_codex_oauth_accounts
      WHERE credential_ref=? AND org_id=? AND principal_type=? AND principal_id=?
        AND project_id=? AND connector_id=? AND account_id=?
        AND state='active' AND pending_kind='refresh'
        AND credential_revision=? AND pending_revision=?`,
    ref, ...this.args(), account, revision, revision + 1);
    if (!row) credentialFail("UNAVAILABLE");
  }
  /** Explicit disconnect wins over a pending refresh by changing its durable intent.
   * A repeated disconnect may resume cleanup of the same exact revision. */
  claimRevoke(ref: string, revision: number, verifiedAccountId: string): void {
    credentialParse(id, ref);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
      credentialFail("UNAVAILABLE");
    const account = credentialParse(accountId, verifiedAccountId);
    const changed = this.tx.run(`UPDATE local_codex_oauth_accounts
      SET pending_kind='revoke',pending_revision=credential_revision+1
      WHERE credential_ref=? AND org_id=? AND principal_type=? AND principal_id=?
        AND project_id=? AND connector_id=? AND account_id=?
        AND state='active' AND credential_revision=?
        AND (pending_kind IS NULL OR pending_kind IN ('refresh','revoke'))`,
    ref, ...this.args(), account, revision);
    if (changed.changes !== 1) credentialFail("UNAVAILABLE");
  }
  completeRefresh(ref: string, previousRevision: number): void {
    const changed = this.tx.run(`UPDATE local_codex_oauth_accounts
      SET credential_revision=pending_revision,pending_kind=NULL,pending_revision=NULL
      WHERE credential_ref=? AND org_id=? AND principal_type=? AND principal_id=?
        AND project_id=? AND connector_id=? AND state='active'
        AND pending_kind='refresh' AND credential_revision=? AND pending_revision=?
        AND EXISTS (SELECT 1 FROM credential_metadata c
          WHERE c.credential_ref=local_codex_oauth_accounts.credential_ref
            AND c.org_id=local_codex_oauth_accounts.org_id
            AND c.principal_type=local_codex_oauth_accounts.principal_type
            AND c.principal_id=local_codex_oauth_accounts.principal_id
            AND c.connector_id=local_codex_oauth_accounts.connector_id
            AND c.revision=local_codex_oauth_accounts.pending_revision AND c.state='active')`,
    ref, ...this.args(), previousRevision, previousRevision + 1);
    if (changed.changes !== 1) credentialFail("UNAVAILABLE");
  }
  completeRevoke(ref: string, previousRevision: number, terminalRevision: number): void {
    if (!Number.isSafeInteger(terminalRevision) || terminalRevision <= previousRevision) credentialFail("UNAVAILABLE");
    const changed = this.tx.run(`UPDATE local_codex_oauth_accounts
      SET credential_revision=?,state='revoked',pending_kind=NULL,pending_revision=NULL
      WHERE credential_ref=? AND org_id=? AND principal_type=? AND principal_id=?
        AND project_id=? AND connector_id=? AND state='active'
        AND pending_kind IS NOT NULL AND credential_revision=?
        AND EXISTS (SELECT 1 FROM credential_metadata c
          WHERE c.credential_ref=local_codex_oauth_accounts.credential_ref
            AND c.org_id=local_codex_oauth_accounts.org_id
            AND c.principal_type=local_codex_oauth_accounts.principal_type
            AND c.principal_id=local_codex_oauth_accounts.principal_id
            AND c.connector_id=local_codex_oauth_accounts.connector_id
            AND c.revision=? AND c.state IN ('revoked','tombstoned'))`,
    terminalRevision, ref, ...this.args(), previousRevision, terminalRevision);
    if (changed.changes !== 1) credentialFail("UNAVAILABLE");
  }
  pendingOperations(): Array<{ ref: string; revision: number; kind: "refresh" | "revoke"; accountId: string }> {
    return this.tx.all(`SELECT credential_ref,credential_revision,pending_kind,account_id FROM local_codex_oauth_accounts
      WHERE org_id=? AND principal_type=? AND principal_id=? AND project_id=? AND connector_id=?
        AND state='active' AND pending_kind IS NOT NULL`, ...this.args())
      .map(row => ({ ref: String(row.credential_ref), revision: Number(row.credential_revision),
        kind: row.pending_kind as "refresh" | "revoke", accountId: String(row.account_id) }));
  }
  pending(): string[] {
    return this.tx.all(`SELECT credential_ref FROM local_codex_oauth_accounts
      WHERE org_id=? AND principal_type=? AND principal_id=? AND project_id=? AND connector_id=?
        AND state='pending'`, ...this.args()).map(row => String(row.credential_ref));
  }
  abandon(ref: string): void {
    credentialParse(id, ref);
    const changed = this.tx.run(`UPDATE local_codex_oauth_accounts SET state='abandoned'
      WHERE credential_ref=? AND org_id=? AND principal_type=? AND principal_id=?
        AND project_id=? AND connector_id=? AND state='pending'`, ref, ...this.args());
    if (changed.changes !== 1) credentialFail("UNAVAILABLE");
  }
  /** F5 always stages before its first Keychain write. A pre-stage denial has no
   * external write to repair, and can close its own connection intent directly. */
  abandonUnstaged(ref: string): boolean {
    credentialParse(id, ref);
    const changed = this.tx.run(`UPDATE local_codex_oauth_accounts SET state='abandoned'
      WHERE credential_ref=? AND org_id=? AND principal_type=? AND principal_id=?
        AND project_id=? AND connector_id=? AND state='pending'
        AND NOT EXISTS (SELECT 1 FROM credential_metadata c WHERE c.credential_ref=local_codex_oauth_accounts.credential_ref)
        AND NOT EXISTS (SELECT 1 FROM credential_staging s WHERE s.credential_ref=local_codex_oauth_accounts.credential_ref)`,
    ref, ...this.args());
    return changed.changes === 1;
  }
}
