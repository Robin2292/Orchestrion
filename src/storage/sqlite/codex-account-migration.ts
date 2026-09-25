import type { SqliteMigration } from "./migrations";

/** Host-only OAuth account pin. Pending rows are durable cleanup obligations. */
export const CODEX_ACCOUNT_MIGRATION: SqliteMigration = {
  version: 21,
  name: "local_codex_oauth_account_binding",
  up: `
    CREATE TABLE local_codex_oauth_accounts (
      credential_ref TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL, principal_type TEXT NOT NULL CHECK(principal_type='user'),
      principal_id TEXT NOT NULL, project_id TEXT NOT NULL, connector_id TEXT NOT NULL,
      account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 256),
      account_display TEXT NOT NULL CHECK(length(account_display) BETWEEN 1 AND 256),
      provenance TEXT NOT NULL CHECK(provenance='trusted_account_verifier'),
      credential_revision INTEGER NOT NULL CHECK(credential_revision=0),
      state TEXT NOT NULL CHECK(state IN ('pending','active','abandoned')),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
    ) STRICT;
    CREATE INDEX local_codex_oauth_account_scope ON local_codex_oauth_accounts
      (org_id,principal_type,principal_id,project_id,connector_id,state);
    CREATE TRIGGER local_codex_oauth_account_insert BEFORE INSERT ON local_codex_oauth_accounts
      WHEN NEW.state!='pending' BEGIN SELECT RAISE(ABORT,'CODEX_ACCOUNT_PENDING_REQUIRED'); END;
    CREATE TRIGGER local_codex_oauth_account_identity BEFORE UPDATE OF credential_ref,org_id,principal_type,
      principal_id,project_id,connector_id,account_id,account_display,provenance,credential_revision
      ON local_codex_oauth_accounts BEGIN SELECT RAISE(ABORT,'CODEX_ACCOUNT_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER local_codex_oauth_account_publish BEFORE UPDATE OF state ON local_codex_oauth_accounts
      BEGIN
      SELECT CASE WHEN OLD.state!='pending' OR NEW.state NOT IN ('active','abandoned')
        THEN RAISE(ABORT,'CODEX_ACCOUNT_TRANSITION_INVALID') END;
      SELECT CASE WHEN NEW.state='active' AND NOT EXISTS (
        SELECT 1 FROM credential_metadata c WHERE c.credential_ref=NEW.credential_ref
          AND c.org_id=NEW.org_id AND c.principal_type=NEW.principal_type
          AND c.principal_id=NEW.principal_id AND c.connector_id=NEW.connector_id
          AND c.revision=NEW.credential_revision AND c.state='active'
      ) THEN RAISE(ABORT,'CODEX_ACCOUNT_CREDENTIAL_MISMATCH') END;
    END;
    CREATE TRIGGER local_codex_oauth_account_retained BEFORE DELETE ON local_codex_oauth_accounts
      BEGIN SELECT RAISE(ABORT,'CODEX_ACCOUNT_RETAINED'); END;
  `,
  // Any row may carry a recovery obligation or an active account pin.
  down: `CREATE TEMP TABLE local_codex_oauth_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_codex_oauth_downgrade_guard SELECT count(*) FROM local_codex_oauth_accounts;
    DROP TABLE local_codex_oauth_downgrade_guard;
    DROP TABLE local_codex_oauth_accounts;`,
};
