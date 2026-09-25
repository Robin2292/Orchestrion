import type { SqliteMigration } from "./migrations";

/** A4C facts live under the D3B Direct Session, never under a parallel session. */
export const DIRECT_CONTEXT_MIGRATION: SqliteMigration = {
  version: 25,
  name: "direct_context_epochs",
  up: `CREATE TABLE direct_context_keys (
      org_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id),
      key_id TEXT NOT NULL UNIQUE CHECK(length(key_id)=36),
      key_check_hash TEXT NOT NULL CHECK(length(key_check_hash)=64 AND key_check_hash NOT GLOB '*[^0-9a-f]*')
    ) STRICT;
    CREATE TABLE direct_context_facts (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 9007199254740991),
      attempt_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('user','assistant','tool_call','tool_result')),
      tool_call_id TEXT, body_cipher_json TEXT NOT NULL CHECK(json_valid(body_cipher_json)),
      body_hash TEXT NOT NULL CHECK(length(body_hash)=64 AND body_hash NOT GLOB '*[^0-9a-f]*'),
      fact_hash TEXT NOT NULL CHECK(length(fact_hash)=64 AND fact_hash NOT GLOB '*[^0-9a-f]*'),
      created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,session_id,seq),
      FOREIGN KEY(org_id,session_id) REFERENCES agent_sessions(org_id,id),
      FOREIGN KEY(org_id,attempt_id) REFERENCES agent_session_attempts(org_id,id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id),
      CHECK((kind IN ('tool_call','tool_result'))=(tool_call_id IS NOT NULL))
    ) STRICT;
    CREATE INDEX ix_direct_context_scope ON direct_context_facts(org_id,project_id,session_id,seq);
    CREATE TABLE direct_context_epochs (
      org_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
      source_start_seq INTEGER NOT NULL CHECK(source_start_seq>0),
      source_end_seq INTEGER NOT NULL CHECK(source_end_seq>=source_start_seq),
      source_hash TEXT NOT NULL CHECK(length(source_hash)=64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
      summary_cipher_json TEXT NOT NULL CHECK(json_valid(summary_cipher_json)),
      summary_hash TEXT NOT NULL CHECK(length(summary_hash)=64 AND summary_hash NOT GLOB '*[^0-9a-f]*'),
      provider_call_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL, assignment_version_id TEXT NOT NULL,
      scope_hash TEXT NOT NULL CHECK(length(scope_hash)=64 AND scope_hash NOT GLOB '*[^0-9a-f]*'),
      created_at TEXT NOT NULL,
      PRIMARY KEY(org_id,session_id,epoch),
      UNIQUE(org_id,provider_call_id),
      FOREIGN KEY(org_id,session_id) REFERENCES agent_sessions(org_id,id),
      FOREIGN KEY(org_id,provider_call_id) REFERENCES direct_provider_calls(org_id,id),
      FOREIGN KEY(org_id,project_id) REFERENCES projects(org_id,id)
    ) STRICT;
    CREATE INDEX ix_direct_context_epoch_scope ON direct_context_epochs(org_id,project_id,session_id,epoch);
    CREATE TRIGGER direct_context_fact_scope BEFORE INSERT ON direct_context_facts
      WHEN NOT EXISTS (SELECT 1 FROM agent_sessions s JOIN agent_session_attempts a
        ON a.org_id=s.org_id AND a.session_id=s.id WHERE s.org_id=NEW.org_id
        AND s.id=NEW.session_id AND s.project_id=NEW.project_id AND s.source='direct'
        AND s.provenance='released' AND a.id=NEW.attempt_id)
      BEGIN SELECT RAISE(ABORT,'DIRECT_CONTEXT_SCOPE'); END;
    CREATE TRIGGER direct_context_epoch_scope BEFORE INSERT ON direct_context_epochs
      WHEN NOT EXISTS (SELECT 1 FROM agent_sessions s JOIN direct_provider_calls p
        ON p.org_id=s.org_id AND p.session_id=s.id WHERE s.org_id=NEW.org_id
        AND s.id=NEW.session_id AND s.project_id=NEW.project_id AND s.source='direct'
        AND s.provenance='released' AND p.id=NEW.provider_call_id AND p.result_state='applied'
        AND json_extract(p.continuation_json,'$.kind')='context_compaction'
        AND p.agent_version_id=NEW.agent_version_id AND p.assignment_version_id=NEW.assignment_version_id)
      BEGIN SELECT RAISE(ABORT,'DIRECT_CONTEXT_SCOPE'); END;
    CREATE TRIGGER direct_context_fact_immutable BEFORE UPDATE ON direct_context_facts
      BEGIN SELECT RAISE(ABORT,'DIRECT_CONTEXT_IMMUTABLE'); END;
    CREATE TRIGGER direct_context_fact_retained BEFORE DELETE ON direct_context_facts
      BEGIN SELECT RAISE(ABORT,'DIRECT_CONTEXT_RETAINED'); END;
    CREATE TRIGGER direct_context_epoch_immutable BEFORE UPDATE ON direct_context_epochs
      BEGIN SELECT RAISE(ABORT,'DIRECT_CONTEXT_IMMUTABLE'); END;
    CREATE TRIGGER direct_context_epoch_retained BEFORE DELETE ON direct_context_epochs
      BEGIN SELECT RAISE(ABORT,'DIRECT_CONTEXT_RETAINED'); END;
    CREATE TRIGGER direct_context_key_immutable BEFORE UPDATE ON direct_context_keys
      BEGIN SELECT RAISE(ABORT,'DIRECT_CONTEXT_KEY_IMMUTABLE'); END;
    CREATE TRIGGER direct_context_key_retained BEFORE DELETE ON direct_context_keys
      BEGIN SELECT RAISE(ABORT,'DIRECT_CONTEXT_KEY_RETAINED'); END;`,
  down: `CREATE TEMP TABLE direct_context_down_guard(n INTEGER CHECK(n=0));
    INSERT INTO direct_context_down_guard SELECT
      (SELECT count(*) FROM direct_context_facts)+(SELECT count(*) FROM direct_context_epochs)
      +(SELECT count(*) FROM direct_context_keys);
    DROP TABLE direct_context_down_guard;
    DROP TABLE direct_context_epochs;
    DROP TABLE direct_context_facts;
    DROP TABLE direct_context_keys;`,
};
