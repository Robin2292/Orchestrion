import type { SqliteMigration } from "./migrations";

/** Preserve the account identity while fencing refresh and disconnect across restarts. */
export const CODEX_ACCOUNT_LIFECYCLE_MIGRATION: SqliteMigration = {
  version: 22,
  name: "local_codex_oauth_account_lifecycle",
  up: `
    DROP TRIGGER local_codex_oauth_account_insert;
    DROP TRIGGER local_codex_oauth_account_identity;
    DROP TRIGGER local_codex_oauth_account_publish;
    DROP TRIGGER local_codex_oauth_account_retained;
    DROP INDEX local_codex_oauth_account_scope;
    ALTER TABLE local_codex_oauth_accounts RENAME TO local_codex_oauth_accounts_v21;
    CREATE TABLE local_codex_oauth_accounts (
      credential_ref TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL, principal_type TEXT NOT NULL CHECK(principal_type='user'),
      principal_id TEXT NOT NULL, project_id TEXT NOT NULL, connector_id TEXT NOT NULL,
      account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 256),
      account_display TEXT NOT NULL CHECK(length(account_display) BETWEEN 1 AND 256),
      provenance TEXT NOT NULL CHECK(provenance='trusted_account_verifier'),
      credential_revision INTEGER NOT NULL CHECK(credential_revision BETWEEN 0 AND 9007199254740991),
      state TEXT NOT NULL CHECK(state IN ('pending','active','abandoned','revoked')),
      pending_kind TEXT CHECK(pending_kind IN ('refresh','revoke')),
      pending_revision INTEGER CHECK(pending_revision BETWEEN 1 AND 9007199254740991),
      CHECK(state!='pending' OR credential_revision=0),
      CHECK((pending_kind IS NULL AND pending_revision IS NULL)
        OR (state='active' AND pending_kind IS NOT NULL AND pending_revision=credential_revision+1)),
      FOREIGN KEY(org_id,principal_type,principal_id) REFERENCES memberships(org_id,principal_type,principal_id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
    ) STRICT;
    INSERT INTO local_codex_oauth_accounts
      (credential_ref,org_id,principal_type,principal_id,project_id,connector_id,
       account_id,account_display,provenance,credential_revision,state)
      SELECT credential_ref,org_id,principal_type,principal_id,project_id,connector_id,
        account_id,account_display,provenance,credential_revision,state
      FROM local_codex_oauth_accounts_v21;
    DROP TABLE local_codex_oauth_accounts_v21;
    CREATE INDEX local_codex_oauth_account_scope ON local_codex_oauth_accounts
      (org_id,principal_type,principal_id,project_id,connector_id,state);
    CREATE TRIGGER local_codex_oauth_account_insert BEFORE INSERT ON local_codex_oauth_accounts
      WHEN NEW.state!='pending' OR NEW.pending_kind IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'CODEX_ACCOUNT_PENDING_REQUIRED'); END;
    CREATE TRIGGER local_codex_oauth_account_identity BEFORE UPDATE OF credential_ref,org_id,principal_type,
      principal_id,project_id,connector_id,account_id,account_display,provenance
      ON local_codex_oauth_accounts BEGIN SELECT RAISE(ABORT,'CODEX_ACCOUNT_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER local_codex_oauth_account_state BEFORE UPDATE OF state ON local_codex_oauth_accounts
      WHEN (OLD.state='pending' AND NEW.state NOT IN ('active','abandoned'))
        OR (OLD.state='active' AND NEW.state NOT IN ('active','revoked'))
        OR OLD.state IN ('abandoned','revoked')
      BEGIN SELECT RAISE(ABORT,'CODEX_ACCOUNT_TRANSITION_INVALID'); END;
    CREATE TRIGGER local_codex_oauth_account_revision BEFORE UPDATE OF
      state,credential_revision,pending_kind,pending_revision ON local_codex_oauth_accounts
      BEGIN
      SELECT CASE WHEN NEW.state='active' AND NEW.pending_kind IS NULL AND NOT EXISTS (
        SELECT 1 FROM credential_metadata c WHERE c.credential_ref=NEW.credential_ref
          AND c.org_id=NEW.org_id AND c.principal_type=NEW.principal_type
          AND c.principal_id=NEW.principal_id AND c.connector_id=NEW.connector_id
          AND c.revision=NEW.credential_revision AND c.state='active'
      ) THEN RAISE(ABORT,'CODEX_ACCOUNT_CREDENTIAL_MISMATCH') END;
      SELECT CASE WHEN NEW.state='revoked' AND NOT EXISTS (
        SELECT 1 FROM credential_metadata c WHERE c.credential_ref=NEW.credential_ref
          AND c.org_id=NEW.org_id AND c.principal_type=NEW.principal_type
          AND c.principal_id=NEW.principal_id AND c.connector_id=NEW.connector_id
          AND c.revision=NEW.credential_revision AND c.state IN ('revoked','tombstoned')
      ) THEN RAISE(ABORT,'CODEX_ACCOUNT_CREDENTIAL_MISMATCH') END;
      SELECT CASE WHEN OLD.state='active' AND NEW.state='active'
        AND NEW.credential_revision!=OLD.credential_revision
        AND NOT (OLD.pending_kind='refresh' AND NEW.pending_kind IS NULL
          AND NEW.credential_revision=OLD.pending_revision)
        THEN RAISE(ABORT,'CODEX_ACCOUNT_REVISION_INVALID') END;
    END;
    CREATE TRIGGER local_codex_oauth_account_retained BEFORE DELETE ON local_codex_oauth_accounts
      BEGIN SELECT RAISE(ABORT,'CODEX_ACCOUNT_RETAINED'); END;
  `,
  // A populated account may carry active authority or unfinished cleanup.
  down: `CREATE TEMP TABLE local_codex_lifecycle_downgrade_guard (n INTEGER CHECK(n=0));
    INSERT INTO local_codex_lifecycle_downgrade_guard SELECT count(*) FROM local_codex_oauth_accounts;
    DROP TABLE local_codex_lifecycle_downgrade_guard;
    DROP TABLE local_codex_oauth_accounts;
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
      BEGIN SELECT RAISE(ABORT,'CODEX_ACCOUNT_RETAINED'); END;`,
};
