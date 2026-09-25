import type { SqliteMigration } from "./migrations";

/** One physical ProviderCall beneath an existing Direct AgentSessionAttempt.
 * Neither the key nor result plaintext is stored in SQLite. */
export const DIRECT_PROVIDER_CALL_MIGRATION: SqliteMigration = {
  version: 24,
  name: "direct_provider_call_authority",
  up: `CREATE TABLE direct_provider_capsule_keys (
      org_id TEXT PRIMARY KEY NOT NULL REFERENCES organizations(id),
      key_id TEXT NOT NULL UNIQUE CHECK(length(key_id)=36),
      key_check_hash TEXT NOT NULL CHECK(length(key_check_hash)=64
        AND key_check_hash NOT GLOB '*[^0-9a-f]*')
    ) STRICT;
    CREATE TABLE direct_provider_calls (
      org_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      agent_version_id TEXT NOT NULL, assignment_version_id TEXT NOT NULL,
      authority_hash TEXT NOT NULL, config_hash TEXT NOT NULL,
      placement_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      source_revision TEXT NOT NULL, fencing_token TEXT NOT NULL,
      logical_slot TEXT NOT NULL CHECK(length(logical_slot) BETWEEN 1 AND 128),
      physical_index INTEGER NOT NULL CHECK(physical_index BETWEEN 1 AND 1000),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      digest_version TEXT NOT NULL CHECK(digest_version='local-provider-request-v1'),
      model_id TEXT NOT NULL, pricing_json TEXT NOT NULL CHECK(json_valid(pricing_json)),
      reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>0),
      reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>=0),
      actual_tokens INTEGER, actual_microusd INTEGER, would_have_microusd INTEGER,
      lifecycle TEXT NOT NULL CHECK(lifecycle IN ('reserved','started','settled','unknown','released')),
      result_state TEXT NOT NULL CHECK(result_state IN ('none','replayable','applied')),
      dispatch_token_hash TEXT, capsule_json TEXT, capsule_hash TEXT,
      decision_hash TEXT, continuation_json TEXT, created_at TEXT NOT NULL, started_at TEXT,
      settled_at TEXT, unknown_at TEXT, applied_at TEXT,
      PRIMARY KEY(org_id,id),
      UNIQUE(org_id,attempt_id,logical_slot,physical_index),
      FOREIGN KEY(org_id,session_id) REFERENCES agent_sessions(org_id,id),
      FOREIGN KEY(org_id,attempt_id) REFERENCES agent_session_attempts(org_id,id),
      FOREIGN KEY(org_id) REFERENCES direct_provider_capsule_keys(org_id),
      CHECK((lifecycle='reserved' AND started_at IS NULL AND dispatch_token_hash IS NULL)
        OR (lifecycle='released' AND started_at IS NULL AND dispatch_token_hash IS NULL)
        OR (lifecycle IN ('started','settled','unknown') AND started_at IS NOT NULL
          AND length(dispatch_token_hash)=64)),
      CHECK((lifecycle='unknown')=(unknown_at IS NOT NULL)),
      CHECK(lifecycle!='settled' OR result_state IN ('replayable','applied')),
      CHECK((lifecycle='settled' AND actual_tokens IS NOT NULL AND actual_microusd IS NOT NULL
          AND would_have_microusd IS NOT NULL AND settled_at IS NOT NULL
          AND actual_tokens BETWEEN 0 AND reserved_tokens
          AND actual_microusd BETWEEN 0 AND reserved_microusd)
        OR (lifecycle!='settled' AND actual_tokens IS NULL AND actual_microusd IS NULL
          AND would_have_microusd IS NULL AND settled_at IS NULL)),
      CHECK((result_state='none' AND capsule_json IS NULL AND capsule_hash IS NULL
          AND decision_hash IS NULL AND continuation_json IS NULL AND applied_at IS NULL)
        OR (result_state='replayable' AND lifecycle='settled'
          AND json_valid(capsule_json) AND length(capsule_hash)=64
          AND decision_hash IS NULL AND continuation_json IS NULL AND applied_at IS NULL)
        OR (result_state='applied' AND lifecycle='settled'
          AND json_valid(capsule_json) AND length(capsule_hash)=64
          AND length(decision_hash)=64 AND json_valid(continuation_json)
          AND applied_at IS NOT NULL))
    ) STRICT;
    CREATE INDEX ix_direct_provider_org_agent ON direct_provider_calls(org_id,agent_id,lifecycle);
    CREATE INDEX ix_direct_provider_org_session ON direct_provider_calls(org_id,session_id,lifecycle);
    CREATE TRIGGER direct_provider_key_immutable BEFORE UPDATE ON direct_provider_capsule_keys
      BEGIN SELECT RAISE(ABORT,'PROVIDER_KEY_IMMUTABLE'); END;
    CREATE TRIGGER direct_provider_key_retained BEFORE DELETE ON direct_provider_capsule_keys
      BEGIN SELECT RAISE(ABORT,'PROVIDER_KEY_RETAINED'); END;
    CREATE TRIGGER direct_provider_call_identity BEFORE UPDATE OF org_id,id,session_id,attempt_id,
      agent_id,agent_version_id,assignment_version_id,authority_hash,config_hash,placement_id,
      workspace_id,source_revision,fencing_token,logical_slot,physical_index,request_digest,
      digest_version,model_id,pricing_json,reserved_tokens,reserved_microusd,created_at
      ON direct_provider_calls BEGIN SELECT RAISE(ABORT,'PROVIDER_CALL_IDENTITY_IMMUTABLE'); END;
    CREATE TRIGGER direct_provider_call_transition BEFORE UPDATE OF lifecycle,result_state
      ON direct_provider_calls WHEN NOT (
        (OLD.lifecycle='reserved' AND NEW.lifecycle IN ('started','released') AND NEW.result_state='none')
        OR (OLD.lifecycle='started' AND NEW.lifecycle IN ('settled','unknown')
          AND NEW.result_state IN ('none','replayable'))
        OR (OLD.lifecycle='unknown' AND NEW.lifecycle='unknown' AND NEW.result_state='none')
        OR (OLD.lifecycle='settled' AND NEW.lifecycle='settled'
          AND OLD.result_state='replayable' AND NEW.result_state='applied')
      ) BEGIN SELECT RAISE(ABORT,'PROVIDER_CALL_STATE_CONFLICT'); END;
    CREATE TRIGGER direct_provider_call_retained BEFORE DELETE ON direct_provider_calls
      BEGIN SELECT RAISE(ABORT,'PROVIDER_CALL_RETAINED'); END;`,
  down: `CREATE TEMP TABLE direct_provider_down_guard (n INTEGER CHECK(n=0));
    INSERT INTO direct_provider_down_guard SELECT
      (SELECT count(*) FROM direct_provider_calls)+(SELECT count(*) FROM direct_provider_capsule_keys);
    DROP TABLE direct_provider_down_guard;
    DROP TABLE direct_provider_calls;
    DROP TABLE direct_provider_capsule_keys;`,
};
