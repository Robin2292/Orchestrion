import type { SqliteMigration } from "./migrations";

/** Mutable presentation state is separate from D3A's immutable Session facts. */
export const DIRECT_SESSION_MIGRATION: SqliteMigration = {
  version: 18,
  name: "direct_session_lifecycle",
  up: `
    CREATE TABLE direct_session_state (
      org_id TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK(length(title)>0 AND length(title)<=255),
      deleted_at TEXT, updated_at TEXT NOT NULL,
      deletion_state TEXT NOT NULL DEFAULT 'ready' CHECK(deletion_state IN ('ready','pending')),
      compat_record_json TEXT CHECK(compat_record_json IS NULL OR json_valid(compat_record_json)),
      compat_principal_type TEXT, compat_principal_id TEXT,
      CHECK((compat_record_json IS NULL AND compat_principal_type IS NULL AND compat_principal_id IS NULL)
        OR (compat_record_json IS NOT NULL AND compat_principal_type IS NOT NULL AND compat_principal_id IS NOT NULL)),
      PRIMARY KEY(org_id,session_id),
      FOREIGN KEY(org_id,session_id) REFERENCES agent_sessions(org_id,id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
    ) STRICT;
    CREATE TRIGGER m9_direct_state_scope BEFORE INSERT ON direct_session_state
      WHEN NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.org_id=NEW.org_id
        AND s.id=NEW.session_id AND s.project_id=NEW.project_id AND s.source='direct')
      BEGIN SELECT RAISE(ABORT,'M9_DIRECT_SESSION_SCOPE'); END;
    CREATE TRIGGER m9_direct_state_identity BEFORE UPDATE OF
      org_id,session_id,project_id,compat_principal_type,compat_principal_id ON direct_session_state
      BEGIN SELECT RAISE(ABORT,'M9_IMMUTABLE_FACT'); END;
    CREATE TRIGGER m9_direct_state_compat_insert BEFORE INSERT ON direct_session_state
      WHEN NEW.compat_record_json IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s WHERE s.org_id=NEW.org_id AND s.id=NEW.session_id
          AND s.project_id=NEW.project_id AND s.provenance='legacy_unversioned'
          AND json_extract(NEW.compat_record_json,'$.id')=s.id
          AND json_extract(NEW.compat_record_json,'$.agentId')=s.agent_id
          AND json_extract(NEW.compat_record_json,'$.threadId')=s.original_thread_id)
      BEGIN SELECT RAISE(ABORT,'M9_DIRECT_COMPAT_MISMATCH'); END;
    CREATE TRIGGER m9_direct_state_compat_update BEFORE UPDATE OF compat_record_json ON direct_session_state
      WHEN NEW.compat_record_json IS NULL OR NOT EXISTS (
        SELECT 1 FROM agent_sessions s WHERE s.org_id=NEW.org_id AND s.id=NEW.session_id
          AND s.project_id=NEW.project_id AND s.provenance='legacy_unversioned'
          AND json_extract(NEW.compat_record_json,'$.id')=s.id
          AND json_extract(NEW.compat_record_json,'$.agentId')=s.agent_id
          AND json_extract(NEW.compat_record_json,'$.threadId')=s.original_thread_id)
      BEGIN SELECT RAISE(ABORT,'M9_DIRECT_COMPAT_MISMATCH'); END;
    CREATE TRIGGER m9_direct_state_retained BEFORE DELETE ON direct_session_state
      BEGIN SELECT RAISE(ABORT,'M9_IMMUTABLE_FACT'); END;
    CREATE TRIGGER m9_direct_state_tombstone BEFORE UPDATE OF deleted_at ON direct_session_state
      WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at
      BEGIN SELECT RAISE(ABORT,'M9_DIRECT_SESSION_DELETED'); END;
    CREATE TRIGGER m9_direct_state_deletion BEFORE UPDATE OF deletion_state ON direct_session_state
      WHEN OLD.deletion_state='pending' AND NEW.deletion_state!='pending'
      BEGIN SELECT RAISE(ABORT,'M9_DIRECT_DELETE_PENDING'); END;
    INSERT INTO direct_session_state(org_id,session_id,project_id,title,updated_at,
      compat_record_json,compat_principal_type,compat_principal_id)
    SELECT s.org_id,s.id,s.project_id,
      coalesce(nullif(substr(json_extract(s.legacy_configuration_evidence,'$.record.title'),1,255),''),'Untitled session'),
      s.created_at,t.record_json,t.principal_type,t.principal_id
      FROM agent_sessions s LEFT JOIN local_session_tree_sessions t
        ON t.org_id=s.org_id AND t.project_id=s.project_id AND t.id=s.id
      WHERE s.source='direct';
    -- A provider-backed tree record crosses to one SQLite writer atomically.
    -- Native JSON and threadless Desktop drafts remain on their original paths.
    DELETE FROM local_session_tree_sessions WHERE EXISTS (
      SELECT 1 FROM direct_session_state d JOIN agent_sessions s
        ON s.org_id=d.org_id AND s.id=d.session_id
      WHERE d.org_id=local_session_tree_sessions.org_id
        AND d.session_id=local_session_tree_sessions.id
        AND d.project_id=local_session_tree_sessions.project_id
        AND d.compat_record_json IS NOT NULL AND s.provenance='legacy_unversioned');
  `,
  down: `
    CREATE TEMP TABLE m9_direct_down_guard(n INTEGER CHECK(n=0));
    INSERT INTO m9_direct_down_guard SELECT count(*) FROM direct_session_state
      WHERE deleted_at IS NOT NULL OR deletion_state!='ready' OR compat_record_json IS NOT NULL OR EXISTS (
        SELECT 1 FROM agent_sessions s WHERE s.org_id=direct_session_state.org_id
          AND s.id=direct_session_state.session_id AND s.provenance='released')
        OR title != coalesce(nullif(substr(
        json_extract((SELECT legacy_configuration_evidence FROM agent_sessions s
          WHERE s.org_id=direct_session_state.org_id AND s.id=direct_session_state.session_id),
        '$.record.title'),1,255),''),'Untitled session');
    DROP TABLE m9_direct_down_guard;
    DROP TRIGGER m9_direct_state_tombstone;
    DROP TRIGGER m9_direct_state_deletion;
    DROP TRIGGER m9_direct_state_retained;
    DROP TRIGGER m9_direct_state_compat_update;
    DROP TRIGGER m9_direct_state_compat_insert;
    DROP TRIGGER m9_direct_state_identity;
    DROP TRIGGER m9_direct_state_scope;
    DROP TABLE direct_session_state;
  `,
};
