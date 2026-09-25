import type { SqliteMigration } from "./migrations";

/** Immutable encrypted AGENTS.md input beneath one released Direct attempt. */
export const DIRECT_REPOSITORY_INSTRUCTIONS_MIGRATION:SqliteMigration={
  version:26,
  name:"direct_repository_instructions",
  up:`CREATE TABLE direct_repository_instructions (
    org_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL, workspace_binding_id TEXT NOT NULL,
    source_revision TEXT NOT NULL, source_snapshot_id TEXT NOT NULL,
    aggregate_hash TEXT NOT NULL CHECK(length(aggregate_hash)=71),
    read_status TEXT NOT NULL CHECK(read_status IN ('missing','read')),
    file_manifest_json TEXT NOT NULL CHECK(json_valid(file_manifest_json)),
    body_cipher_json TEXT NOT NULL CHECK(json_valid(body_cipher_json)),
    body_hash TEXT NOT NULL CHECK(length(body_hash)=64),
    PRIMARY KEY(org_id,attempt_id),
    FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
    FOREIGN KEY(org_id,session_id) REFERENCES agent_sessions(org_id,id),
    FOREIGN KEY(org_id,attempt_id) REFERENCES agent_session_attempts(org_id,id),
    FOREIGN KEY(org_id) REFERENCES direct_context_keys(org_id)
  ) STRICT;
  CREATE INDEX ix_direct_repository_session ON direct_repository_instructions(org_id,project_id,session_id);
  CREATE TRIGGER direct_repository_scope BEFORE INSERT ON direct_repository_instructions
    WHEN NOT EXISTS (SELECT 1 FROM agent_sessions s JOIN agent_session_attempts a
      ON a.org_id=s.org_id AND a.session_id=s.id WHERE s.org_id=NEW.org_id
      AND s.project_id=NEW.project_id AND s.id=NEW.session_id AND s.source='direct'
      AND s.provenance='released' AND a.id=NEW.attempt_id
      AND a.workspace_binding_id=NEW.workspace_binding_id)
    BEGIN SELECT RAISE(ABORT,'DIRECT_REPOSITORY_SCOPE'); END;
  CREATE TRIGGER direct_repository_immutable BEFORE UPDATE ON direct_repository_instructions
    BEGIN SELECT RAISE(ABORT,'DIRECT_REPOSITORY_IMMUTABLE'); END;
  CREATE TRIGGER direct_repository_retained BEFORE DELETE ON direct_repository_instructions
    BEGIN SELECT RAISE(ABORT,'DIRECT_REPOSITORY_RETAINED'); END;`,
  down:`CREATE TEMP TABLE direct_repository_down_guard(n INTEGER CHECK(n=0));
    INSERT INTO direct_repository_down_guard SELECT count(*) FROM direct_repository_instructions;
    DROP TABLE direct_repository_down_guard;
    DROP TABLE direct_repository_instructions;`,
};
